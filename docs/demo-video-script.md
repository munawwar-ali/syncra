# Demo video script (90 seconds)

Shot list for recording the demo. Every scene can be reproduced with the apps in this repository.
Record at 1080p with burned-in captions, and publish a GIF version for the README.

Setup: run `docker compose -f infra/compose/docker-compose.yml up`, open the notes app in two windows (sign in as "Ada" and "Ben") and the dashboard in a third.

| Time         | Visual                                                                                                                                                                     | Caption                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0:00 to 0:10 | A phone showing "No signal"                                                                                                                                                | "Apps break when the network does."                                     |
| 0:10 to 0:20 | Two windows editing one note; Ada's cursor visible in Ben's window                                                                                                         | "Edits show up live on every device."                                   |
| 0:20 to 0:35 | In Ben's window, click **Go offline** in the chaos panel and keep typing; the badge reads Offline and the pending counter grows; the **Server view** panel stays unchanged | "Go offline. Keep working. Everything is saved on the device first."    |
| 0:35 to 0:45 | Reload Ben's window (still offline); the text is still there                                                                                                               | "Even after a reload."                                                  |
| 0:45 to 0:55 | Click **Go online**; the badge goes Syncing then Synced; both windows show identical text; the Server view catches up                                                      | "Reconnect, and it merges without conflicts."                           |
| 0:55 to 1:10 | Dashboard live monitor with operations per second and connections                                                                                                          | "Watch your sync nodes live."                                           |
| 1:10 to 1:20 | Document inspector: drag the history slider                                                                                                                                | "Every change is kept in an append-only log, with history and restore." |
| 1:20 to 1:30 | Terminal running `docker compose up`, then the README with the GitHub URL                                                                                                  | "Self-host it with one command. Open source."                           |

Not shown, because it is not yet verified: killing a sync node during a load test (the multi-node stack has not been run).
Do not show any number that is not in `docs/benchmarks.md`.
