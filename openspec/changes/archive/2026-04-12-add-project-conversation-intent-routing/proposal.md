## Why

The project conversation entrypoint currently treats every user message as a new production request and always starts the `goal -> script` workflow. That breaks natural conversation flows such as direct script submission, retrying a failed downstream step, and low-signal messages that need clarification before any pipeline work should begin.

## What Changes

- Add an intent routing layer in the project conversation message flow before any pipeline run is created.
- Classify incoming messages into `retry_failed_task`, `confirm_script_for_waiting_task`, `start_from_direct_script`, `start_from_request`, or `clarify_intent`.
- Route retry-style messages to the existing failed-task retry flow instead of creating a new run.
- Route full-script messages against a `WAITING_SCRIPT_CONFIRM` task to transcript confirmation and continuation of the current task.
- Allow full-script messages without a waiting task to start directly from the post-script pipeline (`tts -> storyboard -> render`) without regenerating a goal or draft script.
- Add a clarification response path for ambiguous inputs such as greetings or low-context prompts; this path should append an assistant clarification message and suggested topic directions without creating a task run.
- Expand conversation-intent inputs to include recent project history and current project/task state, not only prior user utterances.

## Capabilities

### New Capabilities
- `project-conversation-intent-routing`: Detects project chat intent, decides whether to clarify or execute, and dispatches the message into the correct existing or new workflow entrypoint.

### Modified Capabilities
- None.

## Impact

- Affected API entrypoint: `src/app/api/projects/[projectId]/messages/route.ts`
- Affected conversation orchestration and repository logic: `src/lib/data/project-conversations-repository.ts`
- Affected conversation context/state construction: `src/lib/workspace/conversationContext.ts`
- Affected workflow handoff and pipeline reuse behavior around `goal-to-storyboard` and `script-confirmed-to-video`
- Affected conversation timeline behavior because clarification replies must be persisted without binding to a task run
