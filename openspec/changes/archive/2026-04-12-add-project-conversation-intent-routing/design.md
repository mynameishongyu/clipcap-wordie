## Context

The current project conversation API assumes that every incoming message is a new production request. The message route immediately creates a new turn and pipeline run, then starts the `goal-to-storyboard` workflow. That behavior is correct for request-style prompts, but it misroutes three important conversation states that already exist in the system:

- a failed run that should be retried from its failed step
- a `WAITING_SCRIPT_CONFIRM` run that should accept a pasted final script and continue
- an ambiguous chat message that should be clarified before any run is created

The implementation is cross-cutting because it touches the HTTP entrypoint, repository orchestration, task-state inspection, timeline persistence, and workflow handoff. The existing workflows are already split cleanly into `goal-to-storyboard` and `script-confirmed-to-video`, so the main design problem is routing user intent into the right entrypoint without breaking current retry and confirmation behavior.

## Goals / Non-Goals

**Goals:**
- Add a pre-run intent routing layer for project conversation messages.
- Classify messages into five intents: `retry_failed_task`, `confirm_script_for_waiting_task`, `start_from_direct_script`, `start_from_request`, and `clarify_intent`.
- Use richer intent inputs than the current conversation context by including recent user history plus current project task state.
- Reuse existing retry and script-confirmation flows whenever possible.
- Support clarification replies that are persisted into the conversation timeline without creating a task run.

**Non-Goals:**
- Redesign the underlying TTS, storyboard, or Remotion workflows.
- Replace the existing explicit retry button or script confirmation UI.
- Add multi-turn freeform chat capabilities unrelated to video generation.
- Solve arbitrary script editing/version diffing beyond accepting the latest pasted script as the confirmed transcript.

## Decisions

### 1. Add an intent router before run creation

The message route will stop assuming that every message starts a new run. Instead, it will call a repository-level intent router that returns either:

- a clarification-only mutation result with appended assistant timeline items and no task run
- an execution action that delegates to an existing or new workflow initializer

This keeps the HTTP route simple while moving stateful conversation decisions into the repository layer where run history and task status are already available.

Alternatives considered:
- Keep the current route and classify only inside `continueProjectConversationMessage`.
  Rejected because the current initializer already creates a turn and run too early for `clarify_intent`.
- Add a separate `/intent` endpoint.
  Rejected because the client already treats message send as the single conversation entrypoint.

### 2. Use hybrid intent recognition instead of pure keywords

Intent recognition will use both deterministic rules and model-based classification:

- rules for high-confidence signals such as retry keywords plus `FAILED` state, or a waiting-confirmation task plus a long pasted script
- model classification for lower-signal cases and clarification fallback

The classifier input must include:

- current user message
- recent user message history
- active task summary
- latest failed task summary
- latest waiting-for-confirmation task summary
- recent goal/script context when available

This is necessary because the current `conversationContext` only includes deduplicated user messages and cannot explain whether `continue` refers to a failed storyboard run or whether a pasted script should attach to an existing waiting task.

Alternatives considered:
- Rule-only classification.
  Rejected because ambiguous messages and mixed natural language commands will be brittle.
- Model-only classification.
  Rejected because high-confidence state-driven actions such as retry should not depend entirely on probabilistic output.

### 3. Treat `WAITING_SCRIPT_CONFIRM + full script` as confirmation of the current task

When there is a current run in `WAITING_SCRIPT_CONFIRM` and the incoming message is recognized as a full script, the system will confirm that current task and continue it through `script-confirmed-to-video`. It will not create a new run.

This matches the existing state machine and the user's stated preference. It also avoids duplicating work and keeps the script review step authoritative for the task that requested it.

Alternatives considered:
- Always create a new task from the pasted script.
  Rejected because it abandons the current waiting task and creates confusing duplicate work.

### 4. Add a direct-script initializer for post-script execution

When a full script is provided without a waiting confirmation task, the system will create a new conversation turn and run, mark the script step as done with the provided script text, and start `script-confirmed-to-video`.

This avoids forcing direct-script users through goal extraction and draft script generation even though the downstream pipeline already supports continuing from a confirmed script.

Alternatives considered:
- Send direct-script input through `goal-to-storyboard` anyway.
  Rejected because it would regenerate a script the user already wrote.
- Call the existing HITL confirmation path without a waiting task.
  Rejected because that path currently validates against an existing `WAITING_SCRIPT_CONFIRM` run and script tool id.

### 5. Persist clarification replies as normal assistant timeline items with no task binding

`clarify_intent` responses will be appended to the conversation timeline as assistant items so the user sees a coherent chat history. They will not create an active task, pipeline run, or task notice.

The clarification reply should include:

- a short explanation that the system needs more direction
- 2-3 guessed topic directions based on recent project context when available
- a request for concrete script-generation inputs such as topic, audience, tone, and duration

Alternatives considered:
- Return an out-of-band error or validation message.
  Rejected because clarification is part of the conversation, not a request failure.
- Skip persistence and render clarification client-side only.
  Rejected because it would break reload consistency and conversation history.

## Risks / Trade-offs

- [Intent misclassification causes the wrong action] → Prefer deterministic rules for high-risk states, store classifier rationale in logs, and fall back to `clarify_intent` when confidence is low.
- [Retry commands attach to the wrong historical task] → Scope retry intent to the latest retryable failed run for the project instead of searching arbitrarily across history.
- [Direct-script detection mistakes a request for a final script] → Require a stronger full-script signal and route low-confidence cases to clarification instead of execution.
- [Clarification replies clutter the timeline] → Keep clarification concise and only trigger it when no execution intent reaches the confidence threshold.
- [Repository orchestration grows harder to maintain] → Centralize routing in one intent-dispatch layer and keep existing workflow initializers reusable rather than duplicating execution logic.

## Migration Plan

1. Introduce intent routing in the message entrypoint behind the current project conversation API.
2. Add clarification-only persistence and direct-script initialization paths in the repository layer.
3. Reuse the existing retry and script-confirmation continuation flows for their corresponding intents.
4. Validate in development with the main scenarios:
   - new request
   - greeting/ambiguous input
   - failed storyboard/render followed by `continue`
   - waiting script confirmation followed by pasted final script
   - fresh direct full-script submission
5. Roll back by restoring the previous unconditional `start_from_request` message path if routing quality is unacceptable.

## Open Questions

- What confidence threshold should distinguish `start_from_request` from `clarify_intent` for short but possibly valid prompts?
- Should the classifier rationale be persisted only in logs, or also stored in run/turn metadata for debugging in conversation history?
