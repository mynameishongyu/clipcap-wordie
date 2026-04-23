## ADDED Requirements

### Requirement: Project conversation messages SHALL be intent-routed before workflow execution
The system SHALL evaluate each incoming project conversation message before creating a production workflow run. The router SHALL classify the message into exactly one of `retry_failed_task`, `confirm_script_for_waiting_task`, `start_from_direct_script`, `start_from_request`, or `clarify_intent`.

#### Scenario: Explicit generation request starts a new request flow
- **WHEN** the user sends a message that clearly describes a new video or script request
- **THEN** the system classifies the message as `start_from_request`
- **THEN** the system creates a new turn and workflow run using the request-generation path

#### Scenario: Ambiguous message falls back to clarification
- **WHEN** the user sends a message that cannot be confidently mapped to retry, script confirmation, direct script, or a new request
- **THEN** the system classifies the message as `clarify_intent`
- **THEN** the system does not create a workflow run

### Requirement: Intent routing SHALL use project state as classifier context
The system SHALL provide the intent recognizer with recent conversation history and current project execution state. The recognizer input MUST include the latest user message, recent user message history, and summaries of relevant project task states including failed and waiting-for-confirmation runs when present.

#### Scenario: Retry intent uses failed task state
- **WHEN** the project has a latest retryable failed run and the user sends a retry-style instruction such as `continue` or `retry`
- **THEN** the recognizer receives the failed run summary as part of its context
- **THEN** the system may classify the message as `retry_failed_task`

#### Scenario: Waiting script confirmation uses current task state
- **WHEN** the project has a run in `WAITING_SCRIPT_CONFIRM`
- **THEN** the recognizer receives the waiting task summary as part of its context
- **THEN** a pasted full script may be classified against that waiting task instead of being treated as a brand new request

### Requirement: Ambiguous project chat messages SHALL trigger a clarification reply
When the recognizer returns `clarify_intent`, the system SHALL append an assistant clarification reply to the conversation timeline and SHALL NOT create an active task or pipeline run. The clarification reply MUST ask the user what kind of voiceover script they want and MUST include guessed topic directions derived from recent project context when available.

#### Scenario: Greeting produces clarification only
- **WHEN** the user sends a greeting such as `你好` and there is not enough signal to infer an executable intent
- **THEN** the system appends an assistant clarification message to the timeline
- **THEN** the system keeps the conversation without a new active task

### Requirement: Full scripts SHALL confirm the current waiting task when one exists
If the latest active project run is in `WAITING_SCRIPT_CONFIRM` and the incoming message is recognized as a full script, the system SHALL treat the message as confirmation of that current task. The system SHALL continue the existing task through the post-script pipeline instead of creating a new run.

#### Scenario: Waiting task receives pasted final transcript
- **WHEN** the latest active run is waiting for transcript confirmation
- **WHEN** the user sends a message recognized as a complete voiceover script
- **THEN** the system classifies the message as `confirm_script_for_waiting_task`
- **THEN** the system updates the current task with the provided transcript and starts the `tts -> storyboard -> render` continuation flow

### Requirement: Full scripts SHALL start directly from post-script execution when no waiting task exists
If no waiting-for-confirmation task exists and the incoming message is recognized as a full script, the system SHALL create a new run that skips goal generation and draft script generation. The new run SHALL enter the post-script pipeline using the provided script text as the confirmed transcript.

#### Scenario: Fresh direct-script submission skips goal and draft generation
- **WHEN** there is no current run in `WAITING_SCRIPT_CONFIRM`
- **WHEN** the user sends a message recognized as a complete voiceover script
- **THEN** the system classifies the message as `start_from_direct_script`
- **THEN** the system creates a new run whose script state is already satisfied by the provided script text
- **THEN** the system starts downstream execution from TTS generation

### Requirement: Retry-style messages SHALL resume the latest retryable failed task
When the latest retryable project run is in `FAILED` state and the incoming message is recognized as a retry-style instruction, the system SHALL reuse the existing retry flow for that run. The system SHALL NOT create a new run for that message.

#### Scenario: Failed storyboard or render task receives continue
- **WHEN** the latest retryable project run is failed
- **WHEN** the user sends `continue`, `retry`, `继续`, or `重试`
- **THEN** the system classifies the message as `retry_failed_task`
- **THEN** the system resumes the latest failed task from its inferred retry step
- **THEN** the system does not create a replacement run for the same user message
