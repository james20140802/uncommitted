export {
  buildActivitySummary,
  isActivitySummary
} from "./activity-summary.js";
export type {
  ActivityLevel,
  ActivityProjectSummary,
  ActivitySummary,
  ActivitySummaryInput,
  ActivityTheme,
  CommitSignals,
  ManualContextSummary,
  RecurringThreadSummary,
  UncommittedChangeSummary
} from "./activity-summary.js";
export { getHelpText, runCli } from "./cli.js";
export type { CliIo, CliOptions } from "./cli.js";
export { commands, isKnownCommand } from "./commands.js";
export type { Command } from "./commands.js";
export {
  COMPLETION_SHELLS,
  completionInstallHint,
  generateCompletionScript,
  isCompletionShell
} from "./completion.js";
export type { CompletionShell } from "./completion.js";
export {
  CarouselPngRenderError,
  CarouselRenderInputError,
  createCarouselHtmlCards,
  parseCarouselRenderInput,
  renderCarouselPngs
} from "./carousel-renderer.js";
export type {
  CarouselHtmlToPngRenderer,
  CarouselHtmlCard,
  CarouselPngRenderFailure,
  CarouselPngMetadata,
  CarouselPngRenderErrorCode,
  CarouselPngRenderResult,
  CarouselPngVisualAsset,
  CarouselRenderInput,
  CarouselRenderInputErrorCode,
  CarouselVisualStyleMode,
  CarouselVisualTreatment,
  CarouselVisualTreatmentKind,
  RenderCarouselPngsOptions
} from "./carousel-renderer.js";
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
export { isActivitySignal } from "./event-source.js";
export type {
  ActivitySignal,
  ActivitySignalKind,
  EventSource
} from "./event-source.js";
export {
  collectGitActivitySignals,
  GitActivityEventSource
} from "./git-activity-collector.js";
export type {
  CollectGitActivitySignalsOptions
} from "./git-activity-collector.js";
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
  AiProviderHttpRequest,
  AiProviderHttpResponse,
  AiProviderHttpTransport,
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
  SafeProjectSummary,
  SafeRecurringThread,
  SafeStoryCardGist
} from "./ai-provider.js";
export {
  generateStoryFormatPlan,
  isMood,
  isMoodPlan,
  loadRecentStoryFormatHistory,
  MOOD_VOCABULARY,
  recordStoryFormatHistory
} from "./story-format-plan.js";
export type {
  Mood,
  MoodPlan,
  ProjectPersonaHint,
  RecordStoryFormatHistoryOptions,
  RecentStoryFormat,
  StoryFormatPlanOptions,
  StoryPacing,
  StoryFormatStructurePart
} from "./story-format-plan.js";
export {
  deriveCaptionText,
  generateCaption,
  generateDiaryDraft
} from "./diary-generator.js";
export type {
  CaptionResult,
  DiaryDraft,
  DiaryDraftMetadata,
  DiaryGeneratorOptions,
  DiarySlide,
  GenerateCaptionOptions
} from "./diary-generator.js";
export {
  checkDraftSafety,
  createSafetyReport,
  isSafetyReport
} from "./safety-report.js";
export type {
  SafetyCheckResult,
  SafetyRedaction,
  SafetyReport,
  SafetyRisk,
  SafetyRiskCategory,
  SafetyRiskSeverity,
  SafetyStatus
} from "./safety-report.js";
export {
  ARCHITECTURE_DISCLOSURE_REASON,
  ARCHITECTURE_DISCLOSURE_REPLACEMENT,
  detectArchitectureDisclosure,
  redactArchitectureDisclosure
} from "./architecture-disclosure.js";
export type { ArchitectureDisclosureMatch } from "./architecture-disclosure.js";
export { buildCaptionCardGist } from "./caption-card-gist.js";
export {
  buildCaptionCardRoleLines,
  buildCaptionLengthLine,
  buildCaptionSkeletonLines
} from "./caption-card-role.js";
export {
  buildLaunchAgentPlist,
  captureProviderEnv,
  getLaunchdLabel,
  KNOWN_PROVIDER_ENV_KEYS,
  parseScheduleTime,
  resolveLaunchAgentPlistPath,
  resolveSchedulerLogPaths
} from "./scheduler.js";
export type {
  LaunchAgentPlist,
  LaunchAgentPlistOptions,
  SchedulerLogPaths,
  SchedulerPathOptions,
  ScheduleTime
} from "./scheduler.js";
export {
  GenerateCommandError,
  runGenerateCommand
} from "./generate-command.js";
export type {
  GenerateCommandErrorCode,
  GenerateCommandOptions,
  GenerateCommandResult
} from "./generate-command.js";
export {
  RenderCommandError,
  runRenderCommand
} from "./render-command.js";
export type {
  RenderCommandErrorCode,
  RenderCommandOptions,
  RenderCommandResult
} from "./render-command.js";
export {
  createDraftRevision,
  DraftStorageError,
  readLatestDraftPointer,
  writeDraftArtifactBinary,
  writeDraftArtifactJson,
  writeDraftArtifactText,
  writeLatestDraftPointer,
  writeTextDraftRevision
} from "./draft-storage.js";
export type {
  DraftRevision,
  DraftStorageErrorCode,
  LatestDraftPointer,
  TextDraftRevisionInput,
  TextDraftWriteResult
} from "./draft-storage.js";
export {
  createImageAssetProvider,
  generateCarouselVisualAssets,
  VisualAssetGenerationError
} from "./visual-assets.js";
export type {
  CreateImageAssetProviderOptions,
  GenerateCarouselVisualAssetsOptions,
  ImageAssetProvider,
  ImageAssetProviderResult,
  ImageAssetRequest,
  VisualAssetFallbackState,
  VisualAssetGenerationErrorCode,
  VisualAssetGenerationResult,
  VisualAssetMetadata
} from "./visual-assets.js";
export { runInitCommand } from "./init-command.js";
export type {
  InitAnswers,
  InitCommandOptions,
  InitCommandResult,
  InitConfig
} from "./init-command.js";
export type { GlobalConfig } from "./global-config.js";
export { addProject, ProjectAddError } from "./project-add.js";
export type {
  AddProjectOptions,
  AddProjectResult,
  ProjectAddErrorCode
} from "./project-add.js";
export {
  listProjects,
  ProjectRegistryError,
  removeProject
} from "./project-registry.js";
export type {
  ListProjectsResult,
  ProjectRecord,
  ProjectRegistryErrorCode,
  ProjectRegistryOptions,
  ProjectsFile,
  RemoveProjectResult
} from "./project-registry.js";
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
export {
  describeGitHubTokenStatus,
  GITHUB_TOKEN_MASK,
  maskGitHubToken,
  redactGitHubTokenForDisplay
} from "./github-token-safety.js";
