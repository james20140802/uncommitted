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
  UncommittedChangeSummary
} from "./activity-summary.js";
export { getHelpText, runCli } from "./cli.js";
export type { CliIo, CliOptions } from "./cli.js";
export { commands, isKnownCommand } from "./commands.js";
export type { Command } from "./commands.js";
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
  SafeProjectSummary
} from "./ai-provider.js";
export {
  generateStoryFormatPlan,
  loadRecentStoryFormatHistory,
  recordStoryFormatHistory
} from "./story-format-plan.js";
export type {
  ProjectPersonaHint,
  RecordStoryFormatHistoryOptions,
  RecentStoryFormat,
  StoryFormatPlan,
  StoryFormatPlanOptions,
  StoryFormatStructurePart
} from "./story-format-plan.js";
export {
  deriveCaptionText,
  generateDiaryDraft
} from "./diary-generator.js";
export type {
  DiaryDraft,
  DiaryDraftMetadata,
  DiaryGeneratorOptions,
  DiarySlide
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
  GenerateCommandError,
  runGenerateCommand
} from "./generate-command.js";
export type {
  GenerateCommandErrorCode,
  GenerateCommandOptions,
  GenerateCommandResult
} from "./generate-command.js";
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
