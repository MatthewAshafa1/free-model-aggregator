# free-model-aggregator

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/MatthewAshafa1/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/MatthewAshafa1/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A live free-model aggregator in a single zero-dependency Node server. It answers
both the OpenAI Chat Completions wire (`POST /v1/chat/completions`) and the
Anthropic Messages wire (`POST /v1/messages`), in JSON and in server-sent
events, and serves every prompt with a real completion from one of OpenRouter's
fourteen free models, dialled through the grader's gateway. The model is chosen
deterministically from the trial brief: the highest house-rated free model that
meets the prompt (JSON mode needs JSON support, a tools prompt needs tools
support), with failover down that same ranking and the refusals reported in the
`x-makefun-upstream-failures` header. `GET /v1/models` answers in the wire its
auth header names, and `node main.ts --list` prints the catalog the server
registers.

## Run it

```sh
node main.ts
```

The trial sets `MAKEFUN_PROMPT_FILE`, `MAKEFUN_ENV_URL`,
`MAKEFUN_TRIAL_SEED`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and the trial's
dummy keys; the server picks a free port, registers it with the env, serves
the six prompts, then exits 0 when the env's `/work` says done. Outside a
trial it just serves on a free port until stopped.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
