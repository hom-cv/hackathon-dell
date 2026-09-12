import json
from unittest.mock import Mock, patch

import pytest

from backend.incident_agent.worker import (
    AgentBridgeError,
    AgentResult,
    BlackboxApi,
    IncidentClaimConflict,
    NemoClawRunner,
    normalize_report,
    process_next_incident,
)


def completed_report():
    return {
        "status": "completed",
        "summary": "The deployment introduced an N+1 query regression.",
        "diagnosis": "Supplier lookup executes once per inventory item.",
        "confidence": 0.98,
        "actions_taken": [
            {"kind": "query_telemetry", "summary": "Compared baseline and observed query counts."}
        ],
        "evidence": [
            {"kind": "baseline", "reference": "baseline-1", "summary": "One query per request."}
        ],
        "recommendations": [{
            "kind": "rollback",
            "summary": "Roll back the bad join.",
            "rationale": "The prior revision used one lookup.",
            "target": "dep-healthy",
            "requires_operator_approval": True,
        }],
    }


def test_runner_parses_nemoclaw_json_and_adds_bridge_identity():
    envelope = {
        "result": {"payloads": [{"text": json.dumps(completed_report())}], "meta": {"model": "local/qwen"}}
    }
    completed = Mock(returncode=0, stdout=json.dumps(envelope), stderr="")
    runner = NemoClawRunner("blackbox-agent", gateway_port="8990")
    with patch("backend.incident_agent.worker.subprocess.run", return_value=completed) as run:
        result = runner.investigate({
            "id": "incident-1",
            "rule": "database_query_regression",
            "baseline": {"deployment_id": "dep-healthy"},
        })

    assert result.report["agent_id"] == "nemoclaw:blackbox-agent:main"
    assert result.report["model_name"] == "local/qwen"
    assert result.report["recommendations"][0]["requires_operator_approval"] is True
    assert run.call_args.kwargs["env"]["NEMOCLAW_GATEWAY_PORT"] == "8990"
    assert not any(key.startswith("MONGO_") for key in run.call_args.kwargs["env"])
    assert run.call_args.args[0][:5] == [
        "openshell", "sandbox", "exec", "--name", "blackbox-agent",
    ]


def test_runner_rejects_unapproved_mutating_recommendation():
    report = completed_report()
    report["recommendations"][0]["requires_operator_approval"] = False
    envelope = {"result": {"payloads": [{"text": json.dumps(report)}]}}
    completed = Mock(returncode=0, stdout=json.dumps(envelope), stderr="")
    with patch("backend.incident_agent.worker.subprocess.run", return_value=completed):
        with pytest.raises(AgentBridgeError, match="contract"):
            NemoClawRunner("blackbox-agent").investigate({
                "id": "incident-1", "baseline": {"deployment_id": "dep-healthy"},
            })


def test_worker_uses_incident_and_investigation_endpoints():
    api = Mock(spec=BlackboxApi)
    api.open_incidents.return_value = [{"id": "incident-1"}]
    api.claim.return_value = {"id": "incident-1", "rule": "database_query_regression"}
    runner = Mock(spec=NemoClawRunner)
    runner.sandbox = "blackbox-agent"
    runner.agent_id = "main"
    runner.investigate.return_value = AgentResult(
        {**completed_report(), "agent_id": "nemoclaw:blackbox-agent:main", "model_name": "local/qwen"},
        "local/qwen",
    )

    assert process_next_incident(api, runner) is True
    api.open_incidents.assert_called_once_with(limit=1)
    api.claim.assert_called_once_with("incident-1", "nemoclaw:blackbox-agent:main")
    api.submit.assert_called_once()
    assert api.submit.call_args.args[1]["status"] == "completed"


def test_worker_is_idle_without_open_incidents():
    api = Mock(spec=BlackboxApi)
    api.open_incidents.return_value = []
    runner = Mock(spec=NemoClawRunner)
    assert process_next_incident(api, runner) is False
    api.incident.assert_not_called()


def test_worker_skips_incident_claimed_by_another_worker():
    api = Mock(spec=BlackboxApi)
    api.open_incidents.return_value = [{"id": "incident-1"}]
    api.claim.side_effect = IncidentClaimConflict("already claimed")
    runner = Mock(spec=NemoClawRunner)
    runner.sandbox = "blackbox-agent"
    runner.agent_id = "main"

    assert process_next_incident(api, runner) is True
    runner.investigate.assert_not_called()
    api.submit.assert_not_called()


def test_report_aliases_are_normalized_and_unsafe_rollback_is_removed():
    report = completed_report()
    report["evidence"] = [
        {"kind": "observed", "reference": "window-1", "summary": "Seven queries."},
        {"kind": "rule_trigger", "reference": "query-rule", "summary": "Threshold crossed."},
    ]
    report["recommendations"][0]["target"] = "dep-bad"

    normalized = normalize_report(
        report,
        {"deployment_id": "dep-bad", "baseline": {"deployment_id": "dep-healthy"}},
    )

    assert [item["kind"] for item in normalized["evidence"]] == ["metric", "rule"]
    assert normalized["recommendations"] == []
