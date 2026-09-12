# hackathon-dell
## Blackbox: the project we are building

**Blackbox is a fully local AI incident-response agent for software systems.**

Its job is to detect when a production application starts behaving badly, investigate the incident automatically, identify the most likely root cause using telemetry and local source-code history, recommend or execute a safe remediation, and then verify that the system actually recovered.

The important part is that Blackbox is **not a chatbot**. Nobody types “why is production slow?” into a text box. The system notices the failure itself and begins investigating.

The core product loop is:

```text
Production system is healthy
        ↓
A bad deployment happens
        ↓
Latency/errors spike
        ↓
Blackbox automatically detects the anomaly
        ↓
AI investigation begins
        ↓
Blackbox examines:
    metrics
    logs
    deployment history
    Git history
    source-code changes
        ↓
It determines the likely root cause
        ↓
It proposes a remediation
        ↓
Security/policy layer validates the action
        ↓
Rollback/restart/fix happens
        ↓
Blackbox measures the system again
        ↓
It verifies recovery
        ↓
Incident closed
```

That complete closed loop is the product.

---

# Why this project exists

Imagine a company running an internal application.

It might have:

```text
Web / Checkout Service
          ↓
Inventory Service
          ↓
Database
```

Everything works normally.

Then an engineer deploys some new code.

A few seconds later:

```text
p95 latency

120 ms
   ↓
2,900 ms
```

Customers start experiencing delays.

In a normal organization, somebody now has to notice the alert, open dashboards, look through logs, check recent deployments, examine code changes, form hypotheses, run tests, determine which deployment caused the problem, decide whether it is safe to rollback, execute the rollback, and verify recovery.

That can take anywhere from minutes to hours.

Blackbox attempts to automate most of that investigative process.

Instead of an engineer manually jumping between:

```text
Datadog
Grafana
GitHub
logs
terminal
deployment system
source code
```

Blackbox gathers the evidence locally and reasons across it.

---

# The local-AI angle

This is what makes the idea especially appropriate for the Dell × NVIDIA event.

Incident-response data can contain extremely sensitive information:

```text
proprietary source code
customer information
internal service topology
production logs
database queries
infrastructure configuration
security information
credentials
deployment history
```

Many companies would hesitate to send all of that to a cloud-hosted AI model.

Blackbox runs the intelligence **locally on the Dell Pro Max GB10**.

Conceptually:

```text
                 COMPANY MACHINE

      ┌─────────────────────────────┐
      │                             │
      │ Production telemetry        │
      │ Source code                 │
      │ Logs                        │
      │ Git history                 │
      │ Deployment information      │
      │                             │
      │             ↓               │
      │                             │
      │       Local AI model        │
      │                             │
      │             ↓               │
      │                             │
      │        Blackbox Agent       │
      │                             │
      └─────────────────────────────┘

                Internet
                   X
```

The pitch is therefore not simply:

> “We made an AI DevOps tool.”

It is:

> **We built an autonomous incident-response agent capable of investigating sensitive production systems without sending operational data, proprietary code, or logs outside the organization.**

That is a much stronger enterprise use case.

---

# What we're actually building at the hackathon

We are not building something capable of debugging arbitrary production systems.

That would be impossible in one day.

We are building a carefully scoped **production simulation** that demonstrates how such a system would work in the real world.

Our environment should contain approximately three components:

```text
checkout
    │
    ▼
inventory
    │
    ▼
database
```

The application starts healthy.

For example:

```text
checkout latency: 110 ms
inventory latency: 70 ms
error rate: 0.1%
```

Then we deliberately deploy a bad version of `inventory`.

For example, healthy code might perform one bulk database operation:

```python
items = db.get_many(product_ids)
```

The broken deployment changes it into:

```python
items = []

for product_id in product_ids:
    items.append(db.get(product_id))
```

That produces an N+1 database problem.

If every query takes 50 ms and there are 50 products:

```text
healthy implementation
≈ 100 ms

broken implementation
≈ 2,500 ms
```

Now our simulated production system genuinely becomes slow.

---

# The key event: Blackbox wakes up automatically

A normal piece of Python code monitors the application.

Something simple like:

```python
if current_p95 > baseline_p95 * 3:
    trigger_incident()
```

Notice something important here.

We do **not** ask the AI:

> “Is latency high?”

That would be unnecessary.

Normal software can determine that perfectly.

Instead:

```text
DETERMINISTIC SOFTWARE
detects that something is wrong

AI
determines why something is wrong
```

This distinction is central to the architecture.

---

# What information Blackbox receives

When an incident occurs, our system will have several sources of evidence.

### Metrics

For example:

```json
{
  "checkout_p95_ms": 2920,
  "inventory_p95_ms": 2810,
  "database_p95_ms": 65,
  "error_rate": 0.01
}
```

This immediately suggests:

```text
checkout slow
inventory slow
database normal
```

So the problem may be inside inventory.

### Application logs

For example:

```text
10:42:15 inventory GET /items 2841ms
10:42:16 inventory GET /items 2912ms
10:42:17 inventory GET /items 2794ms
```

Possibly with database-query information.

### Deployment history

We maintain something like:

```json
{
  "timestamp": "10:42:08",
  "service": "inventory",
  "commit": "93ab21"
}
```

Now Blackbox can notice:

```text
10:42:08 deployment
10:42:12 latency starts rising
```

Very suspicious.

### Local Git history

Because Git works completely offline, Blackbox can execute:

```bash
git log --oneline -10
git show 93ab21
git diff 93ab21^ 93ab21
```

It discovers:

```diff
- items = db.get_many(product_ids)

+ items = []
+ for product_id in product_ids:
+     items.append(db.get(product_id))
```

Now the model has enough evidence to reason:

```text
The inventory service became slow immediately
after deployment 93ab21.

Database latency itself remains normal.

The deployment replaced a bulk query with
repeated individual database queries.

Likely root cause:
N+1 query regression introduced by 93ab21.
```

That is where the LLM provides genuine value.

---

# What the AI agent actually does

The agent isn't just generating prose.

It has tools.

Conceptually:

```text
Blackbox Agent

Available tools
│
├── get_metrics()
├── get_logs()
├── get_recent_deployments()
├── inspect_git_commit()
├── inspect_git_diff()
├── run_tests()
└── recommend_remediation()
```

The model may reason like this:

```text
OBSERVATION:
checkout latency is 2920ms.

ACTION:
inspect service-level metrics.
```

Tool result:

```text
inventory p95 = 2810ms
database p95 = 65ms
```

Then:

```text
HYPOTHESIS:
problem likely originates in inventory.

ACTION:
inspect recent inventory deployments.
```

Result:

```text
93ab21 deployed 8 seconds before incident.
```

Then:

```text
ACTION:
inspect commit 93ab21.
```

Result:

```diff
bulk query → repeated individual queries
```

Then:

```text
CONCLUSION:
N+1 query introduced by deployment 93ab21.

CONFIDENCE:
94%

RECOMMENDED ACTION:
rollback inventory deployment.
```

That is an actual **tool-using agent**, not just an LLM answering questions.

---

# Where NemoClaw, OpenClaw, and OpenShell fit

This is the hackathon-specific technical architecture.

```text
                         BLACKBOX

                 ┌─────────────────┐
                 │    OpenClaw     │
                 │                 │
                 │ agent behavior  │
                 │ reasoning loop  │
                 │ skills/tools    │
                 └────────┬────────┘
                          │
                          ▼
                 Local NVIDIA model
                          │
                          ▼
                 reasoning/tool calls


        ┌────────────────────────────────┐
        │          OpenShell             │
        │                                │
        │ sandbox                        │
        │ permissions                    │
        │ filesystem restrictions        │
        │ process restrictions           │
        │ network restrictions           │
        └────────────────────────────────┘

                         ▲
                         │
                    NemoClaw
                         │
               configuration/lifecycle
```

Very roughly:

**OpenClaw is the agent.**

**OpenShell is the security boundary.**

**NemoClaw manages the environment.**

The local NVIDIA model is the intelligence used by OpenClaw.

Our normal Python/JavaScript application exists around those pieces.

---

# Security is part of the product

We should not give the AI unrestricted shell access and say:

> “Good luck fixing production.”

That's both unsafe and unimpressive from an engineering perspective.

Instead, the AI returns a structured recommendation:

```json
{
  "incident_id": "INC-104",
  "service": "inventory",
  "culprit_commit": "93ab21",
  "root_cause": "N+1 database query regression",
  "confidence": 0.94,
  "recommended_action": "rollback"
}
```

Then deterministic software examines that recommendation.

For example:

```python
ALLOWED_ACTIONS = {
    "rollback",
    "restart_service"
}

if recommendation.action not in ALLOWED_ACTIONS:
    reject()
```

The architecture becomes:

```text
AI reasoning
      ↓
proposed action
      ↓
security/policy gate
      ↓
approved deterministic operation
      ↓
production system
```

This is much better than:

```text
AI
 ↓
root shell
```

OpenShell strengthens this story because the agent itself also operates in a restricted sandbox.

---

# The rollback

For the hackathon, rollback can be simple.

Our production simulation has:

```text
commit A
healthy

commit B
broken
```

Once Blackbox identifies commit B, the application can switch back to A.

For example:

```bash
git revert HEAD --no-edit
./deploy.sh
```

Or we can simply redeploy the known-good version.

The exact mechanism matters less than showing that the remediation genuinely changes the running system.

---

# Verification is critical

Blackbox should **not** stop after executing a rollback.

That would leave the job half finished.

It should measure the system again:

```text
Before remediation

checkout p95: 2920 ms
inventory p95: 2810 ms

↓

rollback

↓

After remediation

checkout p95: 118 ms
inventory p95: 71 ms
```

Blackbox can then say:

```text
Recovery verified.

Latency returned within 8% of baseline.

Incident resolved.
```

The complete loop is therefore:

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

Those five words essentially describe the product.

---

# What the dashboard looks like

The judges should not primarily see terminals or a chatbot.

They should see an operations interface.

Something approximately like:

```text
┌────────────────────────────────────────────────────────────┐
│ BLACKBOX                                  SYSTEM: DEGRADED │
├──────────────────────────┬─────────────────────────────────┤
│ SERVICE MAP              │ LATENCY                         │
│                          │                                 │
│ checkout                 │                     ╭────────   │
│    │                     │                     │           │
│    ▼                     │ ────────────────────╯           │
│ inventory ⚠              │                                 │
│    │                     │ 118 ms → 2.9 sec                │
│    ▼                     │                                 │
│ database                 │                                 │
├──────────────────────────┴─────────────────────────────────┤
│ INCIDENT                                                   │
│                                                            │
│ 10:42:08  inventory@93ab21 deployed                        │
│ 10:42:12  latency regression detected                      │
│ 10:42:14  Blackbox investigation started                   │
│ 10:42:17  inventory isolated as affected service           │
│ 10:42:22  recent deployment identified                     │
│ 10:42:27  source diff inspected                            │
│ 10:42:30  root cause identified                            │
│                                                            │
│ ROOT CAUSE                                                 │
│                                                            │
│ N+1 database regression                                    │
│ Commit: 93ab21                                             │
│ Confidence: 94%                                            │
│                                                            │
│ Recommended remediation: ROLLBACK                          │
│                                                            │
│                        [ APPROVE ]                          │
└────────────────────────────────────────────────────────────┘
```

After remediation:

```text
SYSTEM: HEALTHY

2.9 sec → 121 ms

✓ rollback completed
✓ latency recovered
✓ error rate normal
✓ incident resolved
```

The dashboard makes the intelligence visible.

---

# The demonstration

The demo should begin with a healthy production environment.

We tell the judges something like:

> Blackbox is a local autonomous SRE agent. Instead of asking it questions, we're going to give it an actual production incident.

Then:

> We're going to break production.

We click:

```text
DEPLOY REGRESSION
```

The audience watches:

```text
HEALTHY
   ↓
DEGRADED
   ↓
INCIDENT DETECTED
   ↓
INVESTIGATING...
```

Blackbox starts populating its investigation timeline.

```text
✓ inspected service metrics
✓ isolated inventory service
✓ found recent deployment
✓ inspected Git diff
```

Then:

```text
ROOT CAUSE FOUND

N+1 query introduced by 93ab21

Confidence 94%
```

Then either:

```text
[Approve rollback]
```

or Blackbox performs the approved action automatically.

Finally:

```text
ROLLING BACK...

2.9 sec
 ↓
121 ms

RECOVERY VERIFIED

INCIDENT RESOLVED
```

That's the entire story in roughly two minutes.

---

# What is AI and what is not

This distinction will help all three team members understand the system.

| Problem                                | Implementation |
| -------------------------------------- | -------------- |
| Is latency above threshold?            | Normal code    |
| Store logs                             | Normal code    |
| Record deployment time                 | Normal code    |
| Read Git diff                          | Tool           |
| Determine which evidence matters       | AI             |
| Correlate deployment + metrics + code  | AI             |
| Determine likely root cause            | AI             |
| Choose appropriate remediation         | AI             |
| Determine whether an action is allowed | Normal code    |
| Actually perform rollback              | Normal code    |
| Determine whether latency recovered    | Normal code    |

That's a strong architecture because AI is only used where reasoning is useful.

---

# The three-person team

The project naturally divides into three systems.

| Person                           | Owns                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| **Production/System Engineer**   | demo services, Git history, metrics, logs, deployment simulation, rollback, recovery |
| **AI/Agent Engineer**            | NemoClaw, OpenClaw, OpenShell, local LLM, Blackbox skill, tools, diagnosis           |
| **Product/Integration Engineer** | dashboard, controller, API integration, incident timeline, remediation UI, demo flow |

The interfaces between them should be extremely simple.

Person 1 produces:

```text
metrics.json
logs.jsonl
deployments.jsonl
Git repository
rollback command
```

Person 2 consumes those and produces:

```json
{
  "root_cause": "...",
  "confidence": 0.94,
  "recommended_action": "rollback"
}
```

Person 3 connects everything and visualizes the lifecycle.

That lets all three work in parallel.

---

# MVP versus stretch goals

The **MVP** is only one deterministic incident:

```text
bad deployment
→ performance regression
→ Blackbox identifies commit
→ rollback
→ recovery
```

If that works reliably, we have the product.

The best stretch goal would be adding a **second fundamentally different incident**, for example:

```text
Incident A
N+1 query
→ rollback

Incident B
service process crashes
→ restart service
```

Then Blackbox has to actually distinguish between situations.

That makes it much harder for someone to dismiss the demo as:

> “Latency high means you always hardcoded rollback.”

Another good stretch feature is a policy system:

```text
Confidence > 95%
+ action low-risk
→ automatic remediation

Confidence 70–95%
→ human approval

Confidence < 70%
→ escalate to engineer
```

Now it looks much closer to something an enterprise could realistically deploy.

---

# What we're explicitly not building

This matters because feature creep will destroy the project.

We are not building:

* a chatbot;
* a general coding assistant;
* a Datadog replacement;
* a Kubernetes management system;
* a full production observability platform;
* a system capable of debugging every incident;
* a giant multi-agent swarm;
* an internet-connected AI product.

We are creating **one polished vertical slice of autonomous incident response**.

It needs to work extremely well.

---

# The bigger product vision

If this became a real startup/product, Blackbox could connect to:

```text
OpenTelemetry
Prometheus
Grafana
Datadog
Kubernetes
Docker
Git
GitHub/GitLab
CI/CD pipelines
PagerDuty
cloud infrastructure
databases
service meshes
```

When an alert occurs, the system could build a complete incident graph:

```text
alert
  │
  ├─ affected service
  │
  ├─ upstream/downstream dependencies
  │
  ├─ recent deployments
  │
  ├─ infrastructure changes
  │
  ├─ logs
  │
  ├─ traces
  │
  └─ source-code changes
           │
           ▼
     reasoning engine
           │
           ▼
      likely causes
           │
           ▼
        actions
```

For highly regulated companies, banks, defense contractors, hospitals, industrial systems, or organizations with strict data-security rules, the entire reasoning system could remain on-premises.

That's the broader vision.

The hackathon project is a small but convincing proof of that concept.

---

## The one-sentence version

If someone walks up to your table and asks what you're building, the answer is:

> **Blackbox is a fully local autonomous SRE agent that detects software incidents, investigates metrics, logs, deployments, and source changes to find the root cause, safely remediates the problem, and verifies recovery without sending proprietary production data to the cloud.**

And internally, your team should remember the product as five stages:

```text
DETECT → INVESTIGATE → DIAGNOSE → REMEDIATE → VERIFY
```

Everything you build today should support one of those five stages.
