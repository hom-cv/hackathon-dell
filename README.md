# hackathon-dell
# Blackbox — Standalone Hackathon Build Guide

This is the updated source-of-truth plan for the three of you. It incorporates the event rules from the slide you shared, the MongoDB requirement, the local GB10 requirement, the revised NVIDIA-stack requirement, the 18:00 submission cutoff, and the architecture we developed. The official event link from your uploaded event details is here: 

The main constraint to keep in mind is that **the agent itself must be built today**. Planning, architecture, scaffolding, and libraries are fine. Your demo/project is due at **18:00**, and the slide explicitly says no more coding or prompting after that point. So the real engineering deadline should be around **16:30–17:00**, not 18:00.

---

# 1. What we are building

**Blackbox is a fully local autonomous incident-response/SRE agent.**

When a software deployment causes a production incident, Blackbox automatically:

```text
DETECT
  ↓
INVESTIGATE
  ↓
DIAGNOSE
  ↓
REMEDIATE
  ↓
VERIFY
```

Nobody has to ask it:

> "Why is production slow?"

Instead, the system notices the incident itself.

A complete demo looks like this:

```text
System healthy
     ↓
Bad inventory deployment
     ↓
Latency: 120ms → 2.8s
     ↓
Blackbox detects anomaly
     ↓
Incident created in MongoDB
     ↓
Local AI agent starts automatically
     ↓
Agent examines:
    metrics
    logs
    deployments
    local Git history
    source diff
     ↓
Agent identifies root cause
     ↓
"Commit 93ab21 introduced N+1 queries"
     ↓
Agent recommends rollback
     ↓
Policy/controller approves action
     ↓
System rolls back
     ↓
Latency: 2.8s → 120ms
     ↓
Blackbox verifies recovery
     ↓
Incident resolved
```

The important differentiator is that **all AI inference stays on the Dell Pro Max GB10**.

No cloud LLM.

No OpenAI API.

No Claude API.

No source code or production logs leaving the machine.

---

# 2. The problem Blackbox solves

When production breaks today, engineers typically jump between:

```text
metrics dashboards
logs
traces
deployment history
Git
source code
terminals
CI/CD
incident management
```

They are essentially performing an evidence-gathering and hypothesis-testing process:

```text
What changed?
What component is slow?
Did anything deploy recently?
What changed in that deployment?
Does the code change explain the telemetry?
What's the safest remediation?
Did the remediation actually fix it?
```

An LLM is useful here because the difficult part isn't checking whether:

```text
latency > 500ms
```

Normal software can do that.

The difficult part is reasoning across heterogeneous evidence.

Blackbox uses AI specifically for that ambiguous reasoning.

---

# 3. Why the local GB10 matters

Production incident information can include:

```text
proprietary source code
customer information
security-sensitive logs
database queries
credentials
internal service topology
deployment history
infrastructure configuration
```

Sending all of that to a cloud model can be unacceptable for many organizations.

So the product story is:

> **Blackbox is an autonomous SRE that can investigate sensitive production systems locally, without sending proprietary operational data to a third-party AI provider.**

That is the reason the GB10 matters. Don't pitch the GB10 simply as "a fast computer."

Pitch it as the thing that makes **private, on-premises autonomous reasoning** practical.

---

# 4. Updated event constraints

Based on the event slide you photographed, design around these constraints:

| Requirement                       | What it means for us                            |
| --------------------------------- | ----------------------------------------------- |
| No prebuilt agents                | Build the Blackbox agent today                  |
| Plans/scaffolds/libraries allowed | This architecture and repo scaffolding are fine |
| NemoClaw / OpenClaw / OpenShell   | Use at least **one of the three**               |
| MongoDB                           | Must be part of the stack                       |
| Inference                         | Must run locally on the GB10                    |
| Demo/project submission           | **18:00 hard deadline**                         |
| After 18:00                       | No coding or prompting                          |
| Slides                            | Due around 19:00                                |
| Top 8                             | 5-minute live pitch around 19:30                |

One major correction from our earlier plan: **you do not need to independently integrate all three NVIDIA/OpenClaw technologies.**

My preferred path is to use **NemoClaw's preconfigured OpenClaw path if it is working on the event machine**, because NemoClaw can manage OpenClaw inside an OpenShell sandbox and route inference through the configured model. OpenClaw is the agent runtime; OpenShell is the constrained execution environment; NemoClaw manages the setup and lifecycle. ([NVIDIA Docs][1])

That may naturally mean you're using all three, but you should treat it as **one integration path**, not three separate projects.

If NemoClaw becomes a time sink, fall back to whatever one required component the organizers have working most reliably.

---

# 5. Final system architecture

This is the architecture I recommend:

```text
                         BLACKBOX
                Dell Pro Max GB10 — Local

┌────────────────────────────────────────────────────────────┐
│                                                            │
│                     DEMO PRODUCTION                        │
│                                                            │
│     Checkout Service ──────► Inventory Service             │
│                                     │                      │
│                                     ▼                      │
│                                  MongoDB                   │
│                              shop.inventory                │
│                                                            │
└──────────────────────────────┬─────────────────────────────┘
                               │
                       telemetry/events
                               │
                               ▼
┌────────────────────────────────────────────────────────────┐
│                         MongoDB                            │
│                                                            │
│    blackbox.metrics                                        │
│    blackbox.logs                                           │
│    blackbox.deployments                                    │
│    blackbox.incidents                                      │
│    blackbox.investigation_events                           │
│    blackbox.remediation_actions                            │
│                                                            │
└──────────────────────────────┬─────────────────────────────┘
                               │
                       anomaly detected
                               │
                               ▼
                     Blackbox Controller
                               │
                               ▼
                  NemoClaw / OpenClaw
                               │
                        LOCAL MODEL
                               │
               ┌───────────────┼────────────────┐
               ▼               ▼                ▼
         query MongoDB      inspect Git     inspect source
               │               │                │
               └───────────────┼────────────────┘
                               ▼
                      Structured diagnosis
                               │
                               ▼
                         Policy Gate
                               │
                               ▼
                           Rollback
                               │
                               ▼
                     Measure new metrics
                               │
                               ▼
                      Verify recovery
                               │
                               ▼
                            MongoDB
                               │
                               ▼
                           Dashboard
```

MongoDB is therefore not something you're attaching merely to satisfy the rules.

It is central to the design.

---

# 6. MongoDB's role

Use one local MongoDB instance with two conceptual databases:

```text
shop
└── inventory

blackbox
├── metrics
├── logs
├── deployments
├── incidents
├── investigation_events
└── remediation_actions
```

The `shop` database is used by your simulated application.

The `blackbox` database is the operational memory of the agent.

That gives you a legitimate answer when a judge asks why MongoDB is there:

> **MongoDB is Blackbox's shared real-time incident and evidence store. The production system writes telemetry and deployment events to it, the AI agent reads evidence from it during investigation, remediation results are recorded back into it, and the dashboard renders the same live incident state.**

That is materially better than storing one random document in MongoDB to satisfy the requirement.

---

# 7. MongoDB document design

### `metrics`

```json
{
  "timestamp": "2026-09-12T11:14:32Z",
  "service": "inventory",
  "metric": "p95_latency_ms",
  "value": 2810
}
```

You can also store one snapshot document:

```json
{
  "timestamp": "2026-09-12T11:14:32Z",
  "checkout_p95_ms": 2920,
  "inventory_p95_ms": 2810,
  "database_p95_ms": 64,
  "error_rate": 0.01
}
```

For a hackathon, the latter is simpler.

### `logs`

```json
{
  "timestamp": "2026-09-12T11:14:33Z",
  "service": "inventory",
  "level": "INFO",
  "route": "/inventory",
  "latency_ms": 2862,
  "message": "Request completed"
}
```

### `deployments`

```json
{
  "timestamp": "2026-09-12T11:14:25Z",
  "service": "inventory",
  "commit": "93ab21",
  "version": "v2"
}
```

### `incidents`

```json
{
  "incident_id": "INC-001",
  "started_at": "2026-09-12T11:14:30Z",
  "status": "investigating",
  "affected_service": "inventory",

  "trigger": {
    "metric": "p95_latency_ms",
    "baseline": 120,
    "observed": 2810
  },

  "root_cause": null,
  "confidence": null,
  "recommended_action": null
}
```

### `investigation_events`

Every interesting step taken by the agent gets recorded here:

```json
{
  "incident_id": "INC-001",
  "timestamp": "2026-09-12T11:14:36Z",
  "type": "evidence",
  "source": "deployment_history",
  "message": "Inventory commit 93ab21 was deployed 5 seconds before the regression."
}
```

Later:

```json
{
  "incident_id": "INC-001",
  "timestamp": "2026-09-12T11:14:44Z",
  "type": "root_cause",
  "message": "N+1 query introduced in commit 93ab21.",
  "confidence": 0.94
}
```

This collection powers the live dashboard timeline.

### `remediation_actions`

```json
{
  "incident_id": "INC-001",
  "timestamp": "2026-09-12T11:14:50Z",
  "action": "rollback",
  "service": "inventory",
  "target_commit": "93ab21",
  "status": "completed",
  "success": true
}
```

---

# 8. The simulated production application

Do not build a complicated microservice architecture.

Use:

```text
Checkout
   ↓
Inventory
   ↓
MongoDB
```

That is enough.

The checkout service asks inventory for approximately 30–50 products.

The healthy inventory implementation performs one bulk query:

```python
items = list(
    db.inventory.find({
        "_id": {"$in": product_ids}
    })
)
```

The bad deployment changes it into repeated lookups:

```python
items = []

for product_id in product_ids:
    item = db.inventory.find_one({"_id": product_id})
    items.append(item)
```

For demo reliability, you may deliberately simulate database/network round-trip cost around the individual query path.

For example:

```python
for product_id in product_ids:
    item = db.inventory.find_one({"_id": product_id})
    time.sleep(0.04)
    items.append(item)
```

With 50 items:

```text
50 × 40ms ≈ 2 seconds
```

Now your regression is deterministic.

The source diff is also visually obvious enough for the AI and judges to understand.

---

# 9. Local Git is part of the evidence

Git does not require GitHub.

Your demo-system repository can contain:

```text
Commit A:
healthy bulk query

Commit B:
N+1 regression
```

When the bad version deploys:

```text
deployments

{
  "service": "inventory",
  "commit": "93ab21"
}
```

Blackbox can locally run:

```bash
git log --oneline -5

git show 93ab21

git diff 93ab21^ 93ab21
```

Then it correlates:

```text
11:14:25 deployment 93ab21

11:14:30 latency regression begins

git diff:
bulk operation → repeated DB operations
```

That's the actual reasoning challenge.

---

# 10. Incident detection should be AI-assisted

Raw anomaly measurement should remain deterministic. Normal code should calculate
metrics, compare them with known baselines, and emit anomaly signals.

For example:

```python
BASELINE_P95 = 150

if current_p95 > BASELINE_P95 * 3:
    emit_anomaly_signal(
        metric="latency_p95",
        observed=current_p95,
        baseline=BASELINE_P95,
        severity="high",
    )
```

The AI-assisted detector then correlates that signal with recent deployments,
logs, traces, and related anomalies. It decides whether the evidence represents a
real incident, suppresses likely noise, and records its reasoning. When it detects
an incident, it inserts:

```json
{
  "incident_id": "INC-001",
  "status": "new",
  "trigger": "latency_p95 exceeded 3x baseline",
  "confidence": 0.94
}
```

into MongoDB. Keep the AI decision bounded: provide structured signals and context,
require structured output, and retain deterministic thresholds as a fallback for
critical conditions.

Then your Blackbox controller detects a new incident.

The easiest implementation is polling:

```python
while True:
    incident = db.incidents.find_one({"status": "new"})

    if incident:
        start_investigation(incident)

    time.sleep(1)
```

If MongoDB Change Streams work instantly, great.

If they don't, **use polling**.

Do not burn 45 minutes debugging something judges cannot see.

---

# 11. What the AI agent should actually do

Blackbox should receive something like:

```text
Investigate incident INC-001.

Determine:
1. affected service
2. likely root cause
3. relevant deployment
4. supporting evidence
5. confidence
6. recommended remediation
```

It should have narrow tools.

| Tool                | Purpose                              |
| ------------------- | ------------------------------------ |
| `get_incident()`    | Read incident metadata               |
| `get_metrics()`     | Retrieve current/service metrics     |
| `get_logs()`        | Retrieve recent logs                 |
| `get_deployments()` | Get recent deployments               |
| `inspect_commit()`  | Read a local Git commit              |
| `inspect_diff()`    | Compare current deployment to parent |
| `run_tests()`       | Optional validation                  |
| `record_event()`    | Add investigation event to MongoDB   |

The model should not receive arbitrary production root access.

The agent explores evidence using these tools.

---

# 12. Agent behavior

The investigation strategy should roughly be:

```text
1. Understand the trigger.

2. Compare service-level metrics.

3. Identify where the regression originates.

4. Inspect recent deployments to that service.

5. Look for temporal correlation.

6. Inspect the associated source diff.

7. Form a root-cause hypothesis.

8. Gather evidence supporting or contradicting it.

9. Select a remediation.

10. Return structured output.
```

Your OpenClaw skill can encode that workflow.

OpenClaw skills are essentially `SKILL.md` instruction files that teach the agent when and how to use its tools. ([OpenClaw][2])

Something like:

```markdown
---
name: blackbox-sre
description: Investigate local production incidents.
---

# Blackbox SRE

For each incident:

1. Inspect incident metrics.
2. Identify degraded services.
3. Inspect recent deployments.
4. Correlate deployments with the incident start time.
5. Inspect source changes associated with suspicious deployments.
6. Form at least one root-cause hypothesis.
7. Gather evidence.
8. Recommend only an approved remediation.
9. Provide a confidence score.

Never modify production source code directly.
```

---

# 13. Structured agent output

The agent needs to finish with a predictable object:

```json
{
  "status": "root_cause_found",
  "incident_id": "INC-001",

  "affected_service": "inventory",

  "root_cause": "N+1 database query regression",

  "culprit_commit": "93ab21",

  "confidence": 0.94,

  "evidence": [
    "Inventory latency increased immediately after deployment 93ab21.",
    "Database latency remained normal.",
    "The commit changed bulk retrieval into repeated individual queries."
  ],

  "recommended_action": "rollback"
}
```

This is the key contract between **Person 1** and **Person 3**.

The dashboard/controller should not have to parse a paragraph written by an LLM.

---

# 14. Remediation architecture

Do not give the AI unrestricted command execution.

Use:

```text
AI
 ↓
recommendation
 ↓
structured action
 ↓
deterministic policy gate
 ↓
known implementation
```

For example:

```python
ALLOWED_ACTIONS = {
    "rollback",
    "restart_service"
}

if diagnosis["recommended_action"] not in ALLOWED_ACTIONS:
    reject()
```

For the hackathon MVP, you can require one human click:

```text
Recommended action

Rollback inventory@93ab21

Confidence: 94%

[ APPROVE ROLLBACK ]
```

That actually makes the enterprise story stronger.

It demonstrates:

```text
autonomous investigation
+
human-controlled production action
```

rather than:

```text
LLM has root access
```

If everything works early, add an automatic-remediation mode later.

---

# 15. Recovery verification

This should be a first-class feature.

After rollback:

```python
restart_inventory()
wait(5)
new_metrics = collect_metrics()
```

Compare:

```text
Before

inventory p95 = 2810ms

After

inventory p95 = 87ms
```

Then update the incident:

```json
{
  "status": "resolved",
  "verified": true,
  "pre_remediation_p95": 2810,
  "post_remediation_p95": 87
}
```

The product should never end with:

> "Rollback succeeded."

It should end with:

> **"Rollback succeeded and telemetry confirms that the system recovered."**

That makes Blackbox closed-loop autonomous incident response.

---

# 16. NVIDIA/OpenClaw stack strategy

Do not have Person 1 manually engineer three different frameworks.

Try this path first:

```text
NemoClaw
    ↓
OpenClaw agent
    ↓
OpenShell sandbox
    ↓
local model on GB10
```

That is exactly what NemoClaw is designed to package: agent runtime, managed inference, sandbox policy, and lifecycle operations. ([NVIDIA Docs][1])

OpenShell handles the sandbox boundary and policy around networking, filesystem, processes, and inference. ([NVIDIA Docs][3])

For local models, NemoClaw/OpenShell can route the sandbox agent through `inference.local` to a configured local backend such as local vLLM or Ollama. ([NVIDIA Docs][4])

But your practical rule today is:

> **Use whichever provided path successfully produces a local agent tool call fastest.**

Your first AI milestone is not Blackbox.

It is:

```text
agent
 ↓
calls get_metrics()
 ↓
receives MongoDB result
 ↓
correctly interprets it
```

Once that works, the unfamiliar AI infrastructure problem is mostly solved.

---

# 17. Updated three-person division

## Person 1 — Agent/runtime owner

They own:

```text
GB10 local inference
NemoClaw/OpenClaw setup
OpenClaw skill
agent tools
MongoDB evidence retrieval
local Git inspection
structured diagnosis
```

Their API to the team should be conceptually:

```bash
./investigate.sh INC-001
```

which returns the structured diagnosis JSON.

They do **not** build the dashboard.

They do **not** build the simulated production service.

Their target is a reliable investigating agent.

---

## Person 2 — Production + MongoDB + remediation owner

This person builds the world that Blackbox observes.

They own:

```text
checkout service
inventory service
MongoDB
healthy implementation
broken implementation
local Git history
deployment scripts
telemetry
logs
incident detector
rollback
recovery verification
```

They expose MongoDB as the common data plane.

Their outputs are:

```text
metrics
logs
deployments
incidents
```

And one deterministic remediation interface:

```bash
./rollback.sh inventory
```

This is the role I'd still recommend for you if you're more comfortable with conventional backend/system engineering than agent tooling.

---

## Person 3 — Product/controller/integration owner

This person should also be **technical lead**.

They own:

```text
dashboard
control-plane API
agent orchestration
incident timeline
approval workflow
calling remediation
displaying recovery
demo flow
final integration
```

Person 3 connects the other two pieces.

They do not need to know how the agent reasons internally.

They consume:

```json
{
  "root_cause": "...",
  "confidence": 0.94,
  "recommended_action": "rollback"
}
```

and turn it into a product experience.

---

# 18. Team dependency model

Your architecture should look like this:

```text
                  PERSON 1
              AI / Agent Runtime
                     │
                     │ diagnosis JSON
                     ▼
                  PERSON 3
             Product / Controller
                ▲            │
                │            │ action
         MongoDB state       ▼
                │         PERSON 2
                └──── Production System
```

MongoDB is the shared state between everyone.

Person 1 should not depend on Person 2 having finished the entire service.

They can insert mock telemetry into MongoDB.

Person 2 should not wait for the AI.

They can hardcode a temporary diagnosis.

Person 3 should not wait for either.

They can build against mocked MongoDB documents.

---

# 19. Repository layout

I would create something approximately like:

```text
blackbox/
│
├── agent/
│   ├── skills/
│   │   └── blackbox-sre/
│   │       └── SKILL.md
│   │
│   ├── tools/
│   │   ├── get_metrics.py
│   │   ├── get_logs.py
│   │   ├── get_deployments.py
│   │   ├── inspect_git.py
│   │   └── record_event.py
│   │
│   └── investigate.sh
│
├── controller/
│   ├── incident_detector.py
│   ├── orchestrator.py
│   ├── remediation.py
│   └── verification.py
│
├── dashboard/
│
├── demo-system/
│   ├── checkout/
│   ├── inventory/
│   ├── deploy_good.sh
│   ├── deploy_bad.sh
│   └── rollback.sh
│
├── db/
│   ├── seed.py
│   └── mongo.py
│
└── README.md
```

One practical concern: don't repeatedly `git checkout` your entire hackathon repository to simulate deployments because you may overwrite active dashboard/agent development.

Either keep `demo-system` as a separate Git repository or implement deployment versions in a way that only affects the demo service.

---

# 20. Controller lifecycle

Person 3's controller essentially implements:

```python
def handle_incident(incident):
    mark_investigating(incident)

    diagnosis = run_agent(incident.id)

    save_diagnosis(diagnosis)

    if diagnosis["recommended_action"] == "rollback":
        request_approval()

    if approved:
        perform_rollback()

    recovery = verify_recovery()

    if recovery:
        resolve_incident()
```

The actual architecture is more important than the programming language.

Use whatever your team can build fastest.

---

# 21. Dashboard design

The main screen should look like an operations product, **not a ChatGPT clone**.

```text
┌────────────────────────────────────────────────────────────┐
│ BLACKBOX                                      SYSTEM: OK   │
├───────────────────────┬────────────────────────────────────┤
│ SERVICE MAP           │ LATENCY                            │
│                       │                                    │
│ Checkout              │                     ╭───────       │
│    │                  │                     │              │
│    ▼                  │ ────────────────────╯              │
│ Inventory ⚠           │                                    │
│    │                  │ 118ms → 2.8s                       │
│    ▼                  │                                    │
│ MongoDB               │                                    │
├───────────────────────┴────────────────────────────────────┤
│ LIVE INVESTIGATION                                         │
│                                                            │
│ 11:14:25  Deployment 93ab21                                │
│ 11:14:30  Anomaly detected                                 │
│ 11:14:32  Blackbox investigation started                   │
│ 11:14:35  Inventory identified as degraded                 │
│ 11:14:39  Recent deployment correlated                     │
│ 11:14:43  Source diff inspected                            │
│                                                            │
│ ROOT CAUSE                                                 │
│ N+1 database query                                         │
│ Commit 93ab21                                              │
│ Confidence 94%                                             │
│                                                            │
│ Recommended action: ROLLBACK                               │
│                                                            │
│                    [ APPROVE ]                             │
└────────────────────────────────────────────────────────────┘
```

After approval:

```text
ROLLBACK EXECUTING...

2.8s
 ↓
121ms

✓ deployment reverted
✓ latency recovered
✓ system within baseline
✓ incident resolved
```

MongoDB's `investigation_events` collection should drive the timeline.

---

# 22. The exact demo

Your pitch/demo should begin with the system healthy.

Say something roughly like:

> Blackbox is a fully local autonomous SRE. It monitors production, investigates incidents across telemetry, deployment history and proprietary source code, recommends controlled remediation, and verifies recovery without sending sensitive data outside the GB10.

Then:

> **Instead of asking the AI a question, we're going to break production.**

Click:

```text
DEPLOY REGRESSION
```

Then stop explaining for a moment.

Let judges watch:

```text
HEALTHY

↓

DEGRADED

↓

INCIDENT DETECTED

↓

INVESTIGATING

↓

DEPLOYMENT CORRELATED

↓

SOURCE CHANGE ANALYZED

↓

ROOT CAUSE FOUND

↓

ROLLBACK

↓

RECOVERY VERIFIED
```

That visual progression is the core of the demo.

---

# 23. Today's build schedule

Given the 18:00 hard submission deadline, use this schedule.

| Time            | Required state                                                             |
| --------------- | -------------------------------------------------------------------------- |
| **10:20–11:00** | Machine setup, MongoDB working, local model/agent basic invocation working |
| **11:00–12:15** | Three people working independently on agent, demo system, dashboard        |
| **12:15–13:00** | Real MongoDB telemetry + agent reads it                                    |
| **13:00–13:45** | Agent identifies bad deployment/source diff correctly                      |
| **By 14:00**    | Ugly end-to-end path should exist                                          |
| **14:00–15:00** | Integrate rollback + recovery verification                                 |
| **15:00–16:00** | Real dashboard + MongoDB investigation timeline                            |
| **16:00–16:30** | Security/policy story, reliability fixes                                   |
| **16:30**       | **FEATURE FREEZE**                                                         |
| **16:30–17:15** | Repeat full demo until reliable                                            |
| **17:15–17:35** | Record final demo video                                                    |
| **17:35–17:50** | Upload and complete submission                                             |
| **17:50–18:00** | Emergency buffer                                                           |

At **14:00**, if you cannot run:

```text
deploy bad
→ detect
→ investigate
→ correctly diagnose
```

then stop adding features.

At **16:30**, if you cannot run:

```text
deploy bad
→ detect
→ investigate
→ diagnose
→ remediate
→ verify
```

then remove whatever component is breaking that loop.

---

# 24. Definition of done

Your project is finished when all of these are true:

| Capability                                          | Required |
| --------------------------------------------------- | -------: |
| Production starts healthy                           |      Yes |
| Bad deployment genuinely degrades it                |      Yes |
| Telemetry is written to MongoDB                     |      Yes |
| Blackbox detects failure automatically              |      Yes |
| Incident is persisted in MongoDB                    |      Yes |
| Local GB10 model is used                            |      Yes |
| Agent reads evidence through tools                  |      Yes |
| Agent checks deployment history                     |      Yes |
| Agent checks local Git/source diff                  |      Yes |
| Agent identifies correct root cause                 |      Yes |
| Agent outputs structured recommendation             |      Yes |
| Remediation is controlled by deterministic software |      Yes |
| Rollback actually changes running system            |      Yes |
| Blackbox verifies telemetry recovery                |      Yes |
| Dashboard shows investigation live                  |      Yes |
| Internet/cloud LLM required                         |   **No** |

Everything beyond this is optional.

---

# 25. Stretch goals, in priority order

Only attempt these after the entire closed loop works.

**Best stretch goal:** add a second failure mode.

For example:

```text
Failure A:
N+1 query
→ rollback

Failure B:
inventory process crashes
→ restart service
```

Now Blackbox must genuinely choose between different remediations.

That is much more impressive than adding five cosmetic features.

Another good extension is confidence-based policy:

```text
confidence ≥ 95%
+ low-risk action
→ auto-remediate

75–95%
→ request human approval

<75%
→ escalate
```

Another is showing the agent's evidence graph:

```text
Deployment 93ab21
       │
       ├── occurred 5s before incident
       │
       ▼
Inventory regression
       │
       ├── database itself still healthy
       │
       ▼
Git diff
       │
       ▼
bulk query → repeated calls
```

Do not add multi-agent orchestration unless everything else is already done.

---

# 26. What not to build

Do not spend today's time building:

```text
Kubernetes
vector databases
RAG
five cooperating agents
cloud integrations
GitHub integrations
Datadog integrations
full OpenTelemetry stack
automatic code generation
AI-generated patches
3D service visualizations
general-purpose debugging
```

Those would all make the hackathon project larger without making the core demo substantially better.

You're proving one idea:

> **A local agent can autonomously investigate sensitive production incidents, make a defensible remediation decision, and verify recovery.**

One excellent incident is enough.

---

# 27. What each person should do immediately

### Person 1 — Agent

The next milestone is:

```text
Local AI works
      ↓
agent calls MongoDB metrics tool
      ↓
receives actual data
      ↓
interprets it correctly
```

Then add deployments.

Then Git.

Then structured diagnosis.

Don't touch the dashboard.

### Person 2 — Production/MongoDB

The next milestone is:

```text
MongoDB running
      ↓
inventory seeded
      ↓
healthy request ≈100ms
      ↓
deploy_bad
      ↓
request ≈2s+
      ↓
metrics/deployment event in MongoDB
      ↓
rollback
      ↓
healthy again
```

Don't touch the agent.

### Person 3 — Product/integration

Immediately mock:

```json
{
  "status": "root_cause_found",
  "root_cause": "N+1 query",
  "confidence": 0.94,
  "recommended_action": "rollback"
}
```

Then build the entire dashboard around that fake result.

Once Person 1 works, replace the mock.

Once Person 2 works, replace fake telemetry.

---

# 28. The simplest possible contracts

Blackbox should have three major boundaries.

### Evidence

MongoDB is the contract:

```text
metrics
logs
deployments
incidents
```

### Diagnosis

Person 1 returns:

```json
{
  "status": "root_cause_found",
  "service": "inventory",
  "root_cause": "N+1 database access",
  "culprit_commit": "93ab21",
  "confidence": 0.94,
  "recommended_action": "rollback"
}
```

### Remediation

Person 2 exposes:

```bash
./rollback.sh inventory
```

and returns success/failure.

That's enough to connect the entire system.

---

# 29. The final pitch

The cleanest one-sentence description is:

> **Blackbox is a fully local autonomous SRE agent that detects production incidents, investigates telemetry, deployments and proprietary source code to identify the root cause, safely remediates the problem, and verifies recovery—all without sending sensitive operational data outside the Dell GB10.**

Then explain MongoDB:

> **MongoDB acts as Blackbox's live operational memory, storing telemetry, deployments, incidents, agent evidence and remediation history so the production system, autonomous agent and dashboard share one source of truth.**

Then explain the NVIDIA stack:

> **The agent runs locally on the GB10, using the OpenClaw/NemoClaw stack for local tool-using reasoning and controlled execution rather than sending production evidence to a cloud model.**

Then demo it.

---

# 30. The principle that should govern every decision today

When anyone proposes another feature, ask:

> **Does this make the Detect → Investigate → Diagnose → Remediate → Verify loop more convincing or more reliable?**

If the answer is no, don't build it.

Your target at 18:00 is not the most technically elaborate system in the room.

It is a project where the judges can literally watch:

```text
healthy production
       ↓
real failure
       ↓
autonomous local investigation
       ↓
correct evidence-backed diagnosis
       ↓
safe action
       ↓
measurable recovery
```

If that works cleanly in two minutes, you have the right project.

[1]: https://docs.nvidia.com/nemoclaw/user-guide/openclaw/about/overview?utm_source=chatgpt.com "Overview of NVIDIA NemoClaw | NVIDIA NemoClaw"
[2]: https://docs.openclaw.ai/tools/skills?utm_source=chatgpt.com "Skills - OpenClaw"
[3]: https://docs.nvidia.com/nemoclaw/user-guide/openclaw/about/how-it-works?utm_source=chatgpt.com "NemoClaw Architecture Overview | NVIDIA NemoClaw"
[4]: https://docs.nvidia.com/nemoclaw/user-guide/openclaw/inference/about-inference-routing?utm_source=chatgpt.com "About Inference Routing | NVIDIA NemoClaw"
