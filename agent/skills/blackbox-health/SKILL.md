---
name: blackbox-health
description: Check whether the local Blackbox application and MongoDB dependency are healthy.
---

# Blackbox health

Use the sandbox's approved application route:

```sh
curl --fail --silent --show-error http://host.openshell.internal:8001/healthz
```

Report the returned database state and HTTP failure, if any. Do not probe other hosts,
ports, or paths, and never request or expose credentials.
