## 1. Intent Routing Foundations

- [x] 1.1 Define the project conversation intent types, classifier input shape, and routing result contract in the conversation API/domain types
- [x] 1.2 Build a project-state summary helper that collects recent user history plus latest active, failed, and waiting-for-confirmation task context for intent recognition
- [x] 1.3 Implement the intent recognition module with deterministic rules for high-confidence retry/waiting-script cases and a clarification fallback path

## 2. Message Entrypoint Dispatch

- [x] 2.1 Refactor the project messages route to call intent routing before creating a run
- [x] 2.2 Add a clarification-only repository flow that appends assistant timeline items without creating an active task or pipeline run
- [x] 2.3 Preserve the existing request-generation flow as the `start_from_request` dispatch target

## 3. Execution Path Integration

- [x] 3.1 Route `retry_failed_task` intent into the existing failed-task retry initialization and continuation flow
- [x] 3.2 Route `confirm_script_for_waiting_task` intent into the existing script confirmation and post-script continuation flow for the current waiting task
- [x] 3.3 Add a direct-script initializer that creates a new run with the provided script already satisfied and starts downstream execution from TTS

## 4. Timeline, Validation, and Testing

- [x] 4.1 Persist clarification replies in conversation history as assistant items that are not bound to a task notice or active task
- [x] 4.2 Add validation and logging for low-confidence or ambiguous routing outcomes, including rationale for retry and direct-script decisions
- [x] 4.3 Cover the main scenarios with tests or equivalent verification: new request, ambiguous greeting, failed-task continue, waiting-task full-script confirmation, and fresh direct-script submission
