import json
from unittest.mock import Mock, patch

import pytest

from backend.incident_agent.worker import (
    AgentBridgeError,
    AgentResult,
    BlackboxApi,
    NemoClawRunner,
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
        result = runner.investigate({"id": "incident-1", "rule": "database_query_regression"})

    assert result.report["agent_id"] == "nemoclaw:blackbox-agent:main"
    assert result.report["model_name"] == "local/qwen"
    assert result.report["recommendations"][0]["requires_operator_approval"] is True
    assert run.call_args.kwargs["env"]["NEMOCLAW_GATEWAY_PORT"] == "8990"
    assert run.call_args.args[0][:3] == ["nemoclaw", "blackbox-agent", "agent"]


def test_runner_rejects_unapproved_mutating_recommendation():
    report = completed_report()
    report["recommendations"][0]["requires_operator_approval"] = False
    envelope = {"result": {"payloads": [{"text": json.dumps(report)}]}}
    completed = Mock(returncode=0, stdout=json.dumps(envelope), stderr="")
    with patch("backend.incident_agent.worker.subprocess.run", return_value=completed):
        with pytest.raises(AgentBridgeError, match="contract"):
            NemoClawRunner("blackbox-agent").investigate({"id": "incident-1"})


def test_worker_uses_incident_and_investigation_endpoints():
    api = Mock(spec=BlackboxApi)
    api.open_incidents.return_value = [{"id": "incident-1"}]
    api.incident.return_value = {"id": "incident-1", "rule": "database_query_regression"}
    runner = Mock(spec=NemoClawRunner)
    runner.sandbox = "blackbox-agent"
    runner.agent_id = "main"
    runner.investigate.return_value = AgentResult(
        {**completed_report(), "agent_id": "nemoclaw:blackbox-agent:main", "model_name": "local/qwen"},
        "local/qwen",
    )

    assert process_next_incident(api, runner) is True
    api.open_incidents.assert_called_once_with(limit=1)
    api.incident.assert_called_once_with("incident-1")
    assert api.submit.call_count == 2
    assert api.submit.call_args_list[0].args[1]["status"] == "in_progress"
    assert api.submit.call_args_list[1].args[1]["status"] == "completed"


def test_worker_is_idle_without_open_incidents():
    api = Mock(spec=BlackboxApi)
    api.open_incidents.return_value = []
    runner = Mock(spec=NemoClawRunner)
    assert process_next_incident(api, runner) is False
    api.incident.assert_not_called()
