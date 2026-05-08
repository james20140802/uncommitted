export { getHelpText, runCli } from "./cli.js";
export type { CliIo, CliOptions } from "./cli.js";
export { commands, isKnownCommand } from "./commands.js";
export type { Command } from "./commands.js";
export {
  collectGitForRegisteredProjects,
  CollectGitCommandError
} from "./collect-git-command.js";
export type {
  CollectGitCommandErrorCode,
  CollectGitCommandOptions,
  CollectGitCommandResult,
  CollectGitFailure,
  CollectGitSuccess,
  GitActivityEvent
} from "./collect-git-command.js";
export {
  createDoctorReport,
  formatDoctorReport,
  getDoctorExitCode,
  runDoctorCommand
} from "./doctor-command.js";
export type {
  CommandCheckResult,
  DoctorCheck,
  DoctorOptions,
  DoctorReport,
  DoctorStatus
} from "./doctor-command.js";
export {
  ensureConfigDirectories,
  expandHomePath,
  resolveConfigPaths
} from "./config-paths.js";
export type { ConfigPathOptions, ConfigPaths } from "./config-paths.js";
export {
  AiGenerationError,
  createAiGenerationRequest,
  createAiProvider,
  generateStructured,
  loadAiProviderConfig,
  MockAiProvider
} from "./ai-provider.js";
export type {
  AiGenerationErrorCode,
  AiGenerationRequestOptions,
  AiGenerationTask,
  AiProvider,
  AiProviderConfig,
  AiProviderName,
  AiProviderRawResponse,
  AiStructuredGenerationRequest,
  AiStructuredGenerationResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  LoadAiProviderConfigOptions,
  MockAiProviderOptions,
  SafeActivitySummary,
  SafeProjectSummary
} from "./ai-provider.js";
export { runInitCommand } from "./init-command.js";
export type {
  InitAnswers,
  InitCommandOptions,
  InitCommandResult,
  InitConfig
} from "./init-command.js";
export { addProject, ProjectAddError } from "./project-add.js";
export type {
  AddProjectOptions,
  AddProjectResult,
  ProjectAddErrorCode,
  ProjectRecord,
  ProjectsFile
} from "./project-add.js";
export {
  listManualNotes,
  NoteCommandError,
  recordManualNote
} from "./note-command.js";
export type {
  ListManualNotesOptions,
  ListManualNotesResult,
  ManualNoteEvent,
  NoteCommandErrorCode,
  RecordManualNoteOptions,
  RecordManualNoteResult
} from "./note-command.js";
