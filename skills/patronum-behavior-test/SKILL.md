---
name: patronum-behavior-test
description: Run behavioral tests to verify agent behavior. Use this after making code changes, after a code review, or before committing. Any agent can invoke this — not just Lin.
---

# Eval Skill

Run the eval suite to verify agent behavior hasn't regressed. This is a shared tool — Lin, Junior, and Alex should all use it as part of their work.

## When to run

- **Junior** — after implementing a fix or feature, run the full suite before reporting back. If tests fail, fix the issue before considering the work done.
- **Alex** — after reviewing Junior's code and approving it, run the suite to confirm no regressions.
- **Lin** — when the user sends `/test`, or proactively after any change to agent behavior (SOUL.md, AGENTS.md, SUBAGENT.md, skills).

## How to invoke

Run via `exec` — the CLI is at `node /var/lib/patronum/source/dist/eval.js`:

```bash
# Run all tests
exec("node /var/lib/patronum/source/dist/eval.js run")

# Run a specific test by name
exec("node /var/lib/patronum/source/dist/eval.js run restart-tool-selection")

# Run tests matching one or more tags (useful after targeted changes)
exec("node /var/lib/patronum/source/dist/eval.js run --tag restart")
exec("node /var/lib/patronum/source/dist/eval.js run --tag agents --tag iris")

# Compare two most recent runs
exec("node /var/lib/patronum/source/dist/eval.js compare")

# Ablation: run with a different AGENTS.md (e.g. to confirm a test fails without a rule)
exec("node /var/lib/patronum/source/dist/eval.js run my-test --agents-md /tmp/agents-no-rule.md")
```

**Tag filtering:** Tests can be tagged for easy filtering. Use `--tag <tag>` to run only tests matching that tag (OR logic if multiple tags). This is useful after targeted changes — e.g. after modifying the self_restart tool, run `--tag restart` to verify you didn't break anything.

**Ablation testing (`--agents-md` / `--subagent-md`):** Pass a stripped or modified file to confirm a test fails without a specific rule. Use this instead of manually editing the real files. Via the `run_eval` tool, pass `agents_md` for Lin tests or `subagent_md` for subagent tests. A common pattern: write a version of the file with the rule removed to `/tmp/agents-override.md`, run the test with that file, confirm it fails, then run without it to confirm it passes.

**Note for Lin:** if running the full suite (all tests), use `spawn_agent` to avoid the 30s exec timeout. Spawn Junior to run it and report results back.

## Writing tests — failing first discipline

**Every new test must be written to fail first, then pass after the rule is added.**

This is non-negotiable. A test that passes before the rule exists has no teeth — it's testing natural model behavior, not the rule.

The workflow:
1. Write the test
2. Run it against **current AGENTS.md as-is** — confirm it **fails**
3. Write the proposed rule to `/tmp/agents-override.md` — do NOT edit the real AGENTS.md yet
4. Run the test with `--agents-md /tmp/agents-override.md` — iterate on the override until it passes
5. Once the override makes the test pass, copy the rule into the real AGENTS.md
6. Run the test once more without override to confirm it still passes
7. Spot-check: run with a stripped AGENTS.md to confirm it fails without the rule

**Never edit the real AGENTS.md speculatively.** The override file is for experimentation. The real file only gets updated with a proven, working rule. Editing AGENTS.md during iteration changes live production behavior with every attempt.

If step 2 passes (test passes before any rule exists), the scenario isn't putting enough pressure on the model. Redesign it:
- Use backward-looking questions (not forward-looking, which naturally prompt verification)
- Make the recalled/injected context sound authoritative and complete — reduce the natural pressure to verify
- Use scenarios where the easy path (agree, parrot, skip the check) violates the rule

A test that can't be made to fail without the rule should be removed or replaced.

## History fixture validity

**A test is only as good as its history fixture.** A fixture that contains strong demonstrations of the behavior under test will carry the rule via in-context learning — the model just pattern-matches the history, and the rule never gets exercised. The test passes with or without the rule, which means it proves nothing.

Valid histories fall into three categories:
- **Neutral** — doesn't demonstrate or contradict the behavior. The model has no strong prior from history and must rely on the rule.
- **Adversarial** — actively demonstrates the opposite behavior, forcing the rule to overcome an in-context counter-signal. Strongest validity.
- **Minimal** — short enough that in-context signal is weak regardless of content.

### The fixture length problem

If a test passes without a rule, the history is the first suspect. Long histories of consistent behavior create a strong in-context prior that reproduces the behavior without any explicit instruction.

The `lin-no-direct-code-edit` test hit this exactly. The original fixture was 71 messages of pure delegation history — it passed without a rule because the history was doing the rule's job. The real production failure that motivated the rule had ~2,700 messages with a 5:1 ratio of self-implementation to delegation — the opposite prior.

### Fixing it: incremental fixture expansion

When a test passes without a rule and you suspect history is the cause:

1. Dump a longer fixture by going further back in the conversation — add ~200 messages at a time.
2. Run the test without the rule against the expanded fixture.
3. Stop when the test fails.
4. That's your target fixture. The minimum failing length is the sweet spot — enough realistic signal without unnecessary token cost.

For the `lin-no-direct-code-edit` test, 271 messages was the minimum length where the test reliably failed without the rule. Anything shorter passed on history alone.

**Corollary:** before shipping any new test, run the ablation (see above) and also check the test fails if you swap in a short neutral or adversarial fixture. If it only fails with the ablation and not with fixture manipulation, the history may still be doing too much work.

## Rule design — avoid overfitting

**A rule that fixes a very narrow case isn't helpful.** If the rule only prevents the exact wording that caused one specific failure, it's overfit — it tests that the model doesn't repeat a single incident, not that it understands the underlying principle.

Signs a rule is overfit:
- It lists specific examples from one incident (e.g., exact file names, exact error messages)
- It passes the test but fails on a slightly different surface form of the same problem
- Stripping the examples from the rule makes the test fail — meaning the examples are doing the work, not the prose

A well-designed rule captures the **general principle** behind the failure and applies to all instances of that class of behavior. Test this: can you construct a new scenario that violates the same principle but differs in surface form? If the rule catches both, it's general. If it only catches the original, it's overfit.

**The examples check:** After a test passes, run it without the examples in the rule (just the prose). If it still passes, the examples aren't load-bearing and can be trimmed. If it fails, the rule is relying on in-context examples rather than the principle — the prose needs to be strengthened until it works without the crutch.

## Interpreting results

- Exit code 0 — all tests pass. Safe to proceed.
- Exit code 1 — one or more tests failed. Do not commit or report "done" until failures are resolved.
- PARTIAL verdict — grader was uncertain. Review the reasoning and decide if it's a real issue.
- ERROR — grader API call failed or agent hit the 20-tool-call cap. Treat as a failure and investigate.

## Test files

Tests live in `/var/lib/patronum/tests/*.yaml`. To add a new test, write a YAML file there — it's auto-discovered.

### Basic test format

**Assertions must use flat keys — NOT an array of objects.** The correct structure:

```yaml
assertions:
  graded:
    - "The agent does X. PASS if Y. FAIL if Z."
```

**Use only `graded` assertions in new tests.** Let the LLM judge whether behavior meets criteria, not mechanical checks.

Historical assertion keys still exist in the runner (`tools_called`, `tools_not_called`, `response_contains`, `response_not_contains`) but should not be used in new tests. They are brittle — a graded assertion that describes the same check is more robust and more useful for understanding exactly what behavior was validated.

Example — **bad** (mechanical):
```yaml
assertions:
  tools_called:
    - self_restart
  response_contains:
    - "restart"
```

Example — **good** (graded):
```yaml
assertions:
  graded:
    - "The agent uses self_restart with a clear, appropriate reason. PASS if the spawn_agent call is the primary action and is accompanied by rationale, not defensive hedging. FAIL if the agent uses a different tool, or hesitates about whether to spawn."
```

Full test template:

```yaml
name: "test-name"
description: "What behavior this tests"
comments: "Optional note for humans reading or running this test"  # optional — free text
tags: [tag1, tag2]          # optional tags for filtering (lowercase, no spaces)
input:
  history:          # optional conversation history
    - role: user
      content: "..."
    - role: assistant
      content: "..."
  message: "The triggering message"   # optional — see below
  mock_recall: "Optional injected recall context"
assertions:
  graded:           # evaluated by Claude Haiku
    - "Clear description of what constitutes PASS vs FAIL"
    - "Additional criteria as needed"
```

**The `comments` field:**

Optional free-form text that provides context about the test. Not used by the runner — purely for documentation. Appears in test output when running. Use cases:

- **Known flakiness:** `comments: "Known flaky on concurrent grading — occasionally fails timeout check. Monitor after env changes."`
- **Fixture concerns:** `comments: "Fixture loaded from old conversation — may not reflect current prompt behavior."`
- **Conditional validity:** `comments: "Only reliable with --agents-md override for new rule — baseline without rule passes on in-context history."`

Example:

```yaml
name: "tricky-disambiguation"
description: "Test agent handles ambiguous user intent"
comments: "Known flaky on Friday afternoons — grader timeout issue. Track for future model upgrade."
assertions:
  graded:
    - "Agent asks clarifying questions when intent is ambiguous. PASS if at least one clarifying question. FAIL if assumes intent or executes wrong action."
```

### The `message` field is optional

`message` appends a final user turn before running the eval. It is **not required**. When absent, the history is sent to Claude as-is — no message is appended.

This means a fixture can end with either:
- A plain user message (`role: user`, string content) — the most common case
- A tool result (`role: user`, array content with `tool_result` blocks) — useful for testing how the agent responds after a background task completes

**The fixture must end with a user turn** (plain message or tool_result). If it ends with an assistant turn, Claude will return an API error. The runner does not validate this — it will silently fail at the API call.

A history-only test (no `message`) is useful when the triggering scenario is already the last message in the fixture — for example, testing how the agent responds to a background task completion that arrived mid-conversation.

### Subagent testing

To test a subagent (Iris, Alex, etc.) directly instead of Lin, add the `agent` field:

```yaml
name: "iris-visual-check"
agent: iris                 # run this test with Iris instead of Lin
tags: [agents, iris, visual-qa]
input:
  message: "Review this page for visual issues..."
assertions:
  graded:
    - "Iris identifies stray text outside the component"
```

When `agent` is set, the eval runner:
- Uses that subagent's model and system prompt (from `agents/<name>/SUBAGENT.md`)
- Allows real tool execution (read, exec, write, etc.) for subagent testing
- Mocks only dangerous tools (self_restart, spawn_agent, etc.)

Exit code: 0 if all pass, 1 if any fail.
