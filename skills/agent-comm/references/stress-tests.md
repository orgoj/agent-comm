# Stress-Test Results

| Test                                                   | Result | Notes                                           |
| ------------------------------------------------------ | ------ | ----------------------------------------------- |
| Basic poll-receive-reply                               | PASS   | 17s round-trip                                  |
| Timeout recovery (poll → timeout → new poll → message) | PASS   | After killing stale while-loop process          |
| Burst 3 messages in one poll                           | PASS   | All 3 delivered in single batch                 |
| Concurrent polls (while-loop + manual poll)            | FAIL   | Race condition, messages lost to auto-mark-read |
| Poll lock: block second poll                           | PASS   | Clear error + fix suggestion                    |
| Poll lock: --force override                            | PASS   | Takes over cleanly                              |
| Poll lock: auto-cleanup on process death               | PASS   | atexit + signal handlers                        |
| Stress: 17x23=391 via real message round-trip          | PASS   | Full chain: send → poll → process → reply       |
| Watch pattern on single poll (Hermes-5)                | PASS   | Immediate notification on message arrival       |
| Watch pattern on single poll (Hermes-nano)             | PASS   | sqrt(144)=12, watch + notify_on_complete        |
| Watch: continuous [MSG] output (Hermes-5)              | PASS   | One-line format, watch_patterns=["[MSG]"]       |
| Watch: never marks read, last_seen_id dedup            | PASS   | Startup dump + incremental tracking             |
| Lock: os.\_exit(1) prevents race on kill               | PASS   | No in-flight request leakage after signal       |
| 600s poll timeout cap                                  | PASS   | Full 120s poll without cutoff (Hermes-nano)     |
