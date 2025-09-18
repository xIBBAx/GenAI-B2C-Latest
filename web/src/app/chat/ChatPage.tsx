"use client";

import { FiChevronDown, FiChevronUp } from "react-icons/fi";
import { format } from "date-fns";
import { DatePicker } from '@mui/x-date-pickers';
import { TextFieldProps } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { Box, TextField } from '@mui/material';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { IoMdClose } from "react-icons/io";
import {
  redirect,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import {
  BackendChatSession,
  BackendMessage,
  ChatFileType,
  ChatSession,
  ChatSessionSharedStatus,
  FileDescriptor,
  FileChatDisplay,
  Message,
  MessageResponseIDInfo,
  RetrievalType,
  StreamingError,
  ToolCallMetadata,
  SubQuestionDetail,
  constructSubQuestions,
  DocumentsResponse,
  AgenticMessageResponseIDInfo,
  UserKnowledgeFilePacket,
} from "./interfaces";

import Prism from "prismjs";
import Cookies from "js-cookie";
import { HistorySidebar } from "./sessionSidebar/HistorySidebar";
import { Persona } from "../admin/assistants/interfaces";
import { HealthCheckBanner } from "@/components/health/healthcheck";
import {
  buildChatUrl,
  buildLatestMessageChain,
  createChatSession,
  getCitedDocumentsFromMessage,
  getHumanAndAIMessageFromMessageNumber,
  getLastSuccessfulMessageId,
  handleChatFeedback,
  nameChatSession,
  PacketType,
  personaIncludesRetrieval,
  processRawChatHistory,
  removeMessage,
  sendMessage,
  SendMessageParams,
  setMessageAsLatest,
  updateLlmOverrideForChatSession,
  updateParentChildren,
  uploadFilesForChat,
  useScrollonStream,
} from "./lib";
import {
  Dispatch,
  SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePopup } from "@/components/admin/connectors/Popup";
import { SEARCH_PARAM_NAMES, shouldSubmitOnLoad } from "./searchParams";
import { LlmDescriptor, useFilters, useLlmManager } from "@/lib/hooks";
import { ChatState, FeedbackType, RegenerationState } from "./types";
import { DocumentResults } from "./documentSidebar/DocumentResults";
import { OnyxInitializingLoader } from "@/components/OnyxInitializingLoader";
import { FeedbackModal } from "./modal/FeedbackModal";
import { ShareChatSessionModal } from "./modal/ShareChatSessionModal";
import { FiArrowDown } from "react-icons/fi";
import { ChatIntro } from "./ChatIntro";
import { AIMessage, HumanMessage } from "./message/Messages";
import { StarterMessages } from "../../components/assistants/StarterMessage";
import {
  AnswerPiecePacket,
  OnyxDocument,
  DocumentInfoPacket,
  StreamStopInfo,
  StreamStopReason,
  SubQueryPiece,
  SubQuestionPiece,
  AgentAnswerPiece,
  RefinedAnswerImprovement,
  MinimalOnyxDocument,
} from "@/lib/search/interfaces";
import { buildFilters } from "@/lib/search/utils";
import { SettingsContext } from "@/components/settings/SettingsProvider";
import Dropzone from "react-dropzone";
import {
  getFinalLLM,
  modelSupportsImageInput,
  structureValue,
} from "@/lib/llm/utils";
import { ChatInputBar } from "./input/ChatInputBar";
import { useChatContext } from "@/components/context/ChatContext";
import { ChatPopup } from "./ChatPopup";
import FunctionalHeader from "@/components/chat/Header";
import { useSidebarVisibility } from "@/components/chat/hooks";
import {
  PRO_SEARCH_TOGGLED_COOKIE_NAME,
  SIDEBAR_TOGGLED_COOKIE_NAME,
} from "@/components/resizable/constants";
import FixedLogo from "@/components/logo/FixedLogo";
import ExceptionTraceModal from "@/components/modals/ExceptionTraceModal";
import { SEARCH_TOOL_ID, SEARCH_TOOL_NAME } from "./tools/constants";
import { useUser } from "@/components/user/UserProvider";
import { ApiKeyModal } from "@/components/llm/ApiKeyModal";
import BlurBackground from "../../components/chat/BlurBackground";
import { NoAssistantModal } from "@/components/modals/NoAssistantModal";
import { useAssistants } from "@/components/context/AssistantsContext";
import TextView from "@/components/chat/TextView";
import { Modal } from "@/components/Modal";
import { useSendMessageToParent } from "@/lib/extension/utils";
import {
  CHROME_MESSAGE,
  SUBMIT_MESSAGE_TYPES,
} from "@/lib/extension/constants";

import { getSourceMetadata } from "@/lib/sources";
import { UserSettingsModal } from "./modal/UserSettingsModal";
import { AgenticMessage } from "./message/AgenticMessage";
import AssistantModal from "../assistants/mine/AssistantModal";
import { useSidebarShortcut } from "@/lib/browserUtilities";
import { FilePickerModal } from "./my-documents/components/FilePicker";

import { SourceMetadata } from "@/lib/search/interfaces";
import { ValidSources } from "@/lib/types";
import {
  FileResponse,
  FolderResponse,
  useDocumentsContext,
} from "./my-documents/DocumentsContext";
import { ChatSearchModal } from "./chat_search/ChatSearchModal";
import { ErrorBanner } from "./message/Resubmit";
import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import GaugeMeter from "@/components/GaugeMeter";

const TEMP_USER_MESSAGE_ID = -1;
const TEMP_ASSISTANT_MESSAGE_ID = -2;
const SYSTEM_MESSAGE_ID = -3;

export enum UploadIntent {
  ATTACH_TO_MESSAGE, // For files uploaded via ChatInputBar (paste, drag/drop)
  ADD_TO_DOCUMENTS, // For files uploaded via FilePickerModal or similar (just add to repo)
}

export function ChatPage({
  toggle,
  documentSidebarInitialWidth,
  sidebarVisible,
  firstMessage,
  initialFolders,
  initialFiles,
}: {
  toggle: (toggled?: boolean) => void;
  documentSidebarInitialWidth?: number;
  sidebarVisible: boolean;
  firstMessage?: string;
  initialFolders?: any;
  initialFiles?: any;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    chatSessions,
    ccPairs,
    tags,
    documentSets,
    llmProviders,
    folders,
    shouldShowWelcomeModal,
    refreshChatSessions,
    proSearchToggled,
  } = useChatContext();

  const {
    selectedFiles,
    selectedFolders,
    addSelectedFile,
    addSelectedFolder,
    clearSelectedItems,
    folders: userFolders,
    files: allUserFiles,
    uploadFile,
    currentMessageFiles,
    setCurrentMessageFiles,
  } = useDocumentsContext();

  const defaultAssistantIdRaw = searchParams?.get(
    SEARCH_PARAM_NAMES.PERSONA_ID
  );
  const defaultAssistantId = defaultAssistantIdRaw
    ? parseInt(defaultAssistantIdRaw)
    : undefined;

  // Function declarations need to be outside of blocks in strict mode
  function useScreenSize() {
    const [screenSize, setScreenSize] = useState({
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    });

    useEffect(() => {
      const handleResize = () => {
        setScreenSize({
          width: window.innerWidth,
          height: window.innerHeight,
        });
      };

      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }, []);

    return screenSize;
  }

  // handle redirect if chat page is disabled
  // NOTE: this must be done here, in a client component since
  // settings are passed in via Context and therefore aren't
  // available in server-side components
  const settings = useContext(SettingsContext);
  const enterpriseSettings = settings?.enterpriseSettings;
  const clearSelectedDocuments = () => {
    setSelectedDocuments([]);
    setSelectedDocumentTokens(0);
    clearSelectedItems();
  };

  const toggleDocumentSelection = (document: OnyxDocument) => {
    setSelectedDocuments((prev) =>
      prev.some((d) => d.document_id === document.document_id)
        ? prev.filter((d) => d.document_id !== document.document_id)
        : [...prev, document]
    );
  };

  const [gaugeSize, setGaugeSize] = useState(calculateGaugeSize());

  function calculateGaugeSize() {
    const width = window.innerWidth;
    if (width < 640) return 112; // Small screens (w-28 = 112px)
    if (width < 768) return 144; // Medium screens (w-36 = 144px)
    return Math.min(144, width * 0.1); // Scale up to 10% of viewport width, capped at 144px
  }

  useEffect(() => {
    const handleResize = () => {
      setGaugeSize(calculateGaugeSize());
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [lastAppliedSummary, setLastAppliedSummary] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);
  const [caseAnalysisConfidence, setCaseAnalysisConfidence] = useState<number | null>(null);
  const [hasCaseAnalysisStarted, setHasCaseAnalysisStarted] = useState(false);
  const [caseAnalysisReasoning, setCaseAnalysisReasoning] = useState<string | null>(null);
  // === Statutes UI state ===
  const [selectedStatutes, setSelectedStatutes] = useState<string[]>([]);
  const [sectionTitle, setSectionTitle] = useState<string>("");

  // States list for the Statutes advanced panel
  const [statesList, setStatesList] = useState<string[]>([]);
  const [loadingStates, setLoadingStates] = useState(false);
  const statesCacheRef = useRef<string[] | null>(null);
  const STATES_CACHE_KEY = "legacy_states_v1";
  const STATES_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

  type LegacyMeta = {
    // judgements
    sc_total?: number;
    hc_total?: number;
    // statutes
    central_total?: number;
    state_total?: number;

    total?: number;
    page?: number;          // current loaded page (1-based)
    page_size?: number;     // usually 20
    has_more?: boolean;     // if the server has more pages for these params
  };

  type QueryParams = {
    query: string;
    courts: string[];
    judge_name: string | null;
    case_title: string | null;
    start_date: string | null; // yyyy-mm-dd or null
    end_date: string | null;   // yyyy-mm-dd or null
    page_size: number;         // 20
    // store refine keywords the user applied at "Apply" time so we can re-apply on later pages
    keywords: string[];
  };

  // Statutes query params (separate from judgements)
  type StatutesQueryParams = {
    query: string;           // free text
    statutes: string[];      // e.g. ["Central Acts", "Assam", "West Bengal"]
    section_title: string | null; // for Advanced: "Search within Section Title"
    page_size: number;       // 20
    keywords: string[];      // refine terms to re-apply on later pages
  };

  // Pager types (judgements vs statutes)
  type PagerEntryBase<TParams> = {
    domain: 'judgements' | 'statutes';
    currentPage: number;          // 1-based
    totalPages: number;           // ceil(total / page_size)
    total?: number;               // convenience
    pageSize: number;
    hasMore: boolean;
    params: TParams;
    cache?: Record<number, any[]>; // page -> results[]
  };

  type JudgementsPagerEntry = PagerEntryBase<QueryParams> & {
    domain: 'judgements';
    // When both SC+HC are selected with advanced filters we split calls per source
    mixedSplit?: {
      sc?: { total: number; params: QueryParams; cache: Record<number, any[]> };
      hc?: { total: number; params: QueryParams; cache: Record<number, any[]> };
    };
  };

  type StatutesPagerEntry = PagerEntryBase<StatutesQueryParams> & {
    domain: 'statutes';
  };

  type PagerEntry = JudgementsPagerEntry | StatutesPagerEntry;

  const [pager, setPager] = useState<Record<string, JudgementsPagerEntry | StatutesPagerEntry>>({});

  const [loadingPageFor, setLoadingPageFor] = useState<string | null>(null); // `${queryId}:${page}`

  const [searchHistory, setSearchHistory] = useState<
    { id: string; query: string; results: any[]; meta?: LegacyMeta }[]
  >([]);

  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchDomain, setSearchDomain] = useState<'judgements' | 'statutes'>('judgements');

  // Which courts are checked in the Advanced panel UI
  const [selectedCourts, setSelectedCourts] = useState<string[]>([]);
  // [] means "default to Supreme Court" per backend logic

  // Keep refined snippets per result index (for current selected query page)
  const [refineSnippetsByIndex, setRefineSnippetsByIndex] = useState<Record<number, { match_count: number; snippets: string[] }>>({});

  // 1) Instant UI: built-in fallback so the list renders immediately
  const HC_FALLBACK = [
    "Allahabad High Court", "Bombay High Court", "Calcutta High Court", "Gauhati High Court",
    "High Court for the State of Telangana", "High Court of Andhra Pradesh", "High Court of Chhattisgarh",
    "High Court of Delhi", "High Court of Gujarat", "High Court of Himachal Pradesh",
    "High Court of Jammu and Kashmir", "High Court of Jharkhand", "High Court of Karnataka",
    "High Court of Kerala", "High Court of Madhya Pradesh", "High Court of Manipur",
    "High Court of Meghalaya", "High Court of Orissa", "High Court of Punjab and Haryana",
    "High Court of Rajasthan", "High Court of Sikkim", "High Court of Tripura",
    "High Court of Uttarakhand", "Madras High Court", "Patna High Court",
  ];

  // Courts list for the Advanced panel
  const [courtsList, setCourtsList] = useState<string[]>(HC_FALLBACK);
  const [loadingCourts, setLoadingCourts] = useState(false);
  const courtsCacheRef = useRef<string[] | null>(null);
  // === Phase-1 scope memory & warning helpers ===
  type Scope = "SC" | "HC" | "Mixed";

  // === Statutes scope memory & warning helpers ===
  type StatutesScope = "Central" | "State" | "Mixed";

  // default [] => Central Acts (backend default), mirroring your courts logic
  const deriveStatutesScopeFromSources = (sources: string[]): StatutesScope => {
    const hasCentral = sources.some((s) => s.trim().toLowerCase() === "central acts");
    const statesOnly = sources.filter((s) => s.trim().toLowerCase() !== "central acts");
    if (hasCentral && statesOnly.length > 0) return "Mixed";
    if (hasCentral || sources.length === 0) return "Central";
    return "State";
  };

  // do we currently have any statutes filters filled?
  const haveAnyStatutesFilters = () =>
    (keywords && keywords.length > 0) || (sectionTitle && sectionTitle.trim().length > 0);

  // remember where statutes filters were last applied
  const [lastAppliedStatutesCtx, setLastAppliedStatutesCtx] = useState<{
    scope: StatutesScope;
    sources: string[];
  } | null>(null);

  // warning dialog state when user changes statutes scope
  const [showStatutesScopeWarn, setShowStatutesScopeWarn] = useState(false);
  const [pendingStatutes, setPendingStatutes] = useState<string[] | null>(null);
  const [statutesScopeWarnText, setStatutesScopeWarnText] = useState<string>("");

  const prettyStatutes = (s: StatutesScope) =>
    s === "Central" ? "Central Acts"
      : s === "State" ? "State Acts"
        : "Central + State Acts";

  const acceptStatutesChangeKeep = () => {
    if (pendingStatutes) setSelectedStatutes(pendingStatutes);
    setPendingStatutes(null);
    setShowStatutesScopeWarn(false);
  };

  const acceptStatutesChangeClear = () => {
    if (pendingStatutes) setSelectedStatutes(pendingStatutes);
    // clear *statutes* filters before re-applying in the new scope
    setKeywords([]);
    setNewKeyword('');
    setSectionTitle('');
    setPendingStatutes(null);
    setShowStatutesScopeWarn(false);
    toast.info("Filters cleared for the selected sources.");
  };

  const cancelStatutesChange = () => {
    setPendingStatutes(null);
    setShowStatutesScopeWarn(false);
  };

  // default [] => SC (backend default)
  const deriveScopeFromCourts = (courts: string[]): Scope => {
    const hasSC = courts.some((c) => c.trim().toLowerCase() === "supreme court");
    const hcOnly = courts.filter((c) => c.trim().toLowerCase() !== "supreme court");
    if (hasSC && hcOnly.length > 0) return "Mixed";
    if (hasSC || courts.length === 0) return "SC";
    return "HC";
  };

  // do we currently have any filters filled?
  const haveAnyFilters = () =>
    (keywords && keywords.length > 0) ||
    (judgeName && judgeName.trim().length > 0) ||
    (caseName && caseName.trim().length > 0) ||
    (state[0]?.startDate && state[0]?.endDate);

  // remember where filters were last applied
  const [lastAppliedCtx, setLastAppliedCtx] = useState<{
    scope: Scope;
    courts: string[];
  } | null>(null);

  // warning dialog state when user changes court scope
  const [showScopeWarn, setShowScopeWarn] = useState(false);
  const [pendingCourts, setPendingCourts] = useState<string[] | null>(null);
  const [scopeWarnText, setScopeWarnText] = useState<string>("");

  // handlers for the scope-change dialog
  const acceptCourtChangeKeep = () => {
    if (pendingCourts) setSelectedCourts(pendingCourts);
    setPendingCourts(null);
    setShowScopeWarn(false);
  };

  const acceptCourtChangeClear = () => {
    if (pendingCourts) setSelectedCourts(pendingCourts);
    // clear filters before the user re-applies for the new scope
    setKeywords([]);
    setJudgeName("");
    setCaseName("");
    setState([{ startDate: null, endDate: null, key: "selection" }]);
    setPendingCourts(null);
    setShowScopeWarn(false);
    toast.info("Filters cleared for the selected courts.");
  };

  const cancelCourtChange = () => {
    setPendingCourts(null);
    setShowScopeWarn(false);
  };

  // Toggle helpers for court checkboxes (with scope-change guard)
  const toggleCourt = (label: string) => {
    const next = selectedCourts.includes(label)
      ? selectedCourts.filter((c) => c !== label)
      : [...selectedCourts, label];

    const currentScope = deriveScopeFromCourts(selectedCourts);
    const nextScope = deriveScopeFromCourts(next);

    // WARN ONLY when the user is LEAVING the scope where filters were last applied.
    // i.e., currentScope must equal lastAppliedCtx.scope, and nextScope must differ.
    if (
      lastAppliedCtx &&
      haveAnyFilters() &&
      currentScope === lastAppliedCtx.scope &&
      nextScope !== lastAppliedCtx.scope
    ) {
      setPendingCourts(next);

      const pretty = (s: Scope) =>
        s === "SC" ? "Supreme Court" : s === "HC" ? "High Courts" : "Supreme + High Courts";

      setScopeWarnText(
        `Your filters were last applied in ${pretty(lastAppliedCtx.scope)}. ` +
        `You're switching to ${pretty(nextScope)}. Those filters may not match there. ` +
        `Recommended: clear filters and re-apply.`
      );
      setShowScopeWarn(true);
      return;
    }

    // otherwise change immediately
    setSelectedCourts(next);
  };

  const isCourtChecked = (label: string) =>
    selectedCourts.some((c) => c.trim().toLowerCase() === label.trim().toLowerCase());

  const [toggleDocSelection, setToggleDocSelection] = useState(false);
  const [documentSidebarVisible, setDocumentSidebarVisible] = useState(false);
  const [proSearchEnabled, setProSearchEnabled] = useState(proSearchToggled);
  const [showPopup, setShowPopup] = useState(false);
  const [showDatePopup, setShowDatePopup] = useState(false);
  const [showAdvancedOption, setShowAdvancedOption] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [judgeName, setJudgeName] = useState('');
  const [caseName, setCaseName] = useState('');
  const [state, setState] = useState<{
    startDate: Date | null;
    endDate: Date | null;
    key: string;
  }[]>([
    { startDate: null, endDate: null, key: 'selection' }
  ]);

  const toggleDatePopup = () => setShowDatePopup(prev => !prev);

  const addKeyword = () => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;

    if (keywords.includes(trimmed)) {
      toast.warning(`"${trimmed}" is already added.`);
      return;
    }

    setKeywords(prev => [...prev, trimmed]);
    setNewKeyword('');
  };

  const removeKeyword = (kw: string) => {
    setKeywords(prev => prev.filter(k => k !== kw));
  };

  // FULL body (no truncation). SC => content/all_text, HC => text/all_text
  function getFullBodyFromRow(r: any): string {
    return r.source === "SC"
      ? String(r.content || r.all_text || "")
      : String(r.text || r.all_text || "");
  }

  // Quote multiline text as blockquote (no HTML)
  function toBlockquote(str: string) {
    return String(str)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  // SC block — all fields + full content
  // SC block — all fields + full content (no source/collection)
  function renderSCBlock(r: any, idx: number) {
    const fileName = r.file_name || "Untitled";
    const caseNo = r.case_no || "—";
    const citation = r.citation || "—";
    const bench = r.bench || "—";
    const judgeBy = r.judgement_by || bench || "—";
    const jdate = r.judgment_dates || "—"; // ISO yyyy-mm-dd (or null)

    const bodyBlock = toBlockquote(getFullBodyFromRow(r));

    return [
      `### ${idx + 1}. Supreme Court — **file_name:** ${fileName}`,
      `**Case No.:** ${caseNo}`,
      `**Citation:** ${citation}`,
      `**Bench:** ${bench}`,
      `**Judgement By:** ${judgeBy}`,
      `**Judgment date:** ${jdate}`,
      ``,
      `---`,
      ``,
      `**Content:**`,
      bodyBlock,
    ].join("\n");
  }

  // HC block — all fields + full text (no source/collection)
  function renderHCBlock(r: any, idx: number) {
    const court = r["Court name"] || r["Court Name"] || "—";
    const title = r.title || "Untitled";
    const caseNumber = r["case number"] || r["Case Number"] || "—";
    const cnr = r["cnr"] || "—";
    const decisionDate = r["decision date"] || r["Decision Date"] || "—";
    const disposalNature = r["disposal nature"] || r["Disposal Nature"] || "—";
    const judge = r.judge || r["Judge"] || "—";

    const bodyBlock = toBlockquote(getFullBodyFromRow(r));

    return [
      `### ${idx + 1}. High Court — **Court name:** ${court} — **Title:** ${title}`,
      `**Case number:** ${caseNumber}`,
      `**CNR:** ${cnr}`,
      `**Decision date:** ${decisionDate}`,
      `**Disposal nature:** ${disposalNature}`,
      `**Judge:** ${judge}`,
      ``,
      `---`,
      ``,
      `**Text:**`,
      bodyBlock,
    ].join("\n");
  }

  // --- Courts cache (localStorage + in-memory) ---
  const COURTS_CACHE_KEY = "legacy_hc_courts_v1";
  const COURTS_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

  function readCachedCourts(): string[] | null {
    try {
      const raw = localStorage.getItem(COURTS_CACHE_KEY);
      if (!raw) return null;
      const { list, ts } = JSON.parse(raw);
      if (!Array.isArray(list) || !ts) return null;
      if (Date.now() - ts > COURTS_CACHE_TTL_MS) return null; // expired
      return list as string[];
    } catch {
      return null;
    }
  }

  function writeCachedCourts(list: string[]) {
    try {
      localStorage.setItem(
        COURTS_CACHE_KEY,
        JSON.stringify({ list, ts: Date.now() })
      );
    } catch {
      // ignore quota errors
    }
  }

  function readCachedStates(): string[] | null {
    try {
      const raw = localStorage.getItem(STATES_CACHE_KEY);
      if (!raw) return null;
      const { list, ts } = JSON.parse(raw);
      if (!Array.isArray(list) || !ts) return null;
      if (Date.now() - ts > STATES_CACHE_TTL_MS) return null; // expired
      return list as string[];
    } catch {
      return null;
    }
  }

  function writeCachedStates(list: string[]) {
    try {
      localStorage.setItem(
        STATES_CACHE_KEY,
        JSON.stringify({ list, ts: Date.now() })
      );
    } catch {
      // ignore quota errors
    }
  }

  // === Mixed-scope helpers (SC + HC) ===
  const bothCourtsSelected = (courts: string[]) => {
    const hasSC = courts.some((c) => c.trim().toLowerCase() === "supreme court");
    const hasHC = courts.some((c) => c.trim().toLowerCase() !== "supreme court");
    return hasSC && hasHC;
  };

  const highCourtsFrom = (courts: string[]) =>
    courts.filter((c) => c.trim().toLowerCase() !== "supreme court");

  // Split base params into SC-only and HC-only for mixed advanced searches
  function splitMixedParams(base: QueryParams) {
    const hcList = highCourtsFrom(base.courts);
    const scSelected = base.courts.some((c) => c.trim().toLowerCase() === "supreme court");
    const scParams = scSelected ? { ...base, courts: ["Supreme Court"] } as QueryParams : null;
    const hcParams = hcList.length ? { ...base, courts: hcList } as QueryParams : null;
    return { scParams, hcParams };
  }

  // Fetch one page (safe: returns empty results array on any non-OK)
  async function fetchJudgementsPage(params: QueryParams, page: number) {
    try {
      const resp = await fetch("/api/legacysearch/judgements/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, page }),
      });
      if (!resp.ok) {
        return { results: [], total: 0, sc_total: 0, hc_total: 0, has_more: false };
      }
      const data = await resp.json();
      return data; // { results, total, sc_total, hc_total, has_more }
    } catch {
      return { results: [], total: 0, sc_total: 0, hc_total: 0, has_more: false };
    }
  }

  async function fetchStatutesPage(params: StatutesQueryParams, page: number, useAdvanced: boolean) {
    try {
      const url = useAdvanced
        ? "/api/legacysearch/statutes/advanced"
        : "/api/legacysearch/statutes/search";

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, page }),
      });
      if (!resp.ok) {
        return { results: [], total: 0, central_total: 0, state_total: 0, has_more: false };
      }
      const data = await resp.json();
      return data; // { results, total, central_total, state_total, page, page_size, has_more }
    } catch {
      return { results: [], total: 0, central_total: 0, state_total: 0, has_more: false };
    }
  }

  // Assemble a combined page from SC then HC (by concatenation order)
  async function assembleMixedPage(entry: JudgementsPagerEntry, page: number): Promise<{ rows: any[]; totals: { total: number; sc_total: number; hc_total: number } }> {
    const PAGE = entry.pageSize;
    const start = (page - 1) * PAGE;
    const end = start + PAGE;

    const scTotal = entry.mixedSplit?.sc?.total ?? 0;
    const hcTotal = entry.mixedSplit?.hc?.total ?? 0;
    const grandTotal = scTotal + hcTotal;

    // Early exit: nothing to show
    if (grandTotal === 0) return { rows: [], totals: { total: 0, sc_total: 0, hc_total: 0 } };

    // Which slices belong to SC vs HC
    const takeFromSC = Math.max(0, Math.min(end, scTotal) - Math.min(start, scTotal)); // overlap with [0, scTotal)
    const scFrom = Math.min(start, scTotal);
    const scTo = scFrom + takeFromSC;

    const takeFromHC = PAGE - takeFromSC;
    const hcFrom = Math.max(0, start - scTotal);
    const hcTo = hcFrom + Math.max(0, Math.min(takeFromHC, Math.max(0, hcTotal - hcFrom)));

    // Helper to pull an arbitrary slice from cached pages (fetch missing ones)
    const sliceFromSource = async (kind: "sc" | "hc", from: number, to: number): Promise<any[]> => {
      const src = entry.mixedSplit?.[kind];
      if (!src || to <= from) return [];

      const pageSize = entry.pageSize; // we use same page size per source
      const firstPage = Math.floor(from / pageSize) + 1;
      const lastPage = Math.floor((to - 1) / pageSize) + 1;

      const results: any[] = [];
      for (let p = firstPage; p <= lastPage; p++) {
        if (!src.cache[p]) {
          const data = await fetchJudgementsPage(src.params, p);
          src.cache[p] = Array.isArray(data.results) ? data.results : [];
        }
      }

      // Collect the exact slice [from, to)
      for (let idx = from; idx < to; idx++) {
        const p = Math.floor(idx / pageSize) + 1;
        const offsetInPage = idx % pageSize;
        const pageArr = src.cache[p] || [];
        if (offsetInPage < pageArr.length) {
          results.push(pageArr[offsetInPage]);
        }
      }
      return results;
    };

    const scSlice = await sliceFromSource("sc", scFrom, scTo);
    const hcSlice = await sliceFromSource("hc", hcFrom, hcTo);

    return {
      rows: [...scSlice, ...hcSlice],
      totals: { total: grandTotal, sc_total: scTotal, hc_total: hcTotal },
    };
  }

  // Synthetic "empty" rows so we can render a visible empty-state block
  const buildEmptySCRow = () => ({
    source: "SC",
    collection: "sc_cases",
    __empty: true,
    file_name: "—",
    case_no: null,
    citation: null,
    bench: null,
    judgement_by: null,
    content: "",
    judgment_dates: null,
  });

  const buildEmptyHCRow = (hcList: string[]) => ({
    source: "HC",
    collection: "hc_cases",
    __empty: true,
    "Court name": hcList.join(", ") || "—",
    title: null,
    "case number": null,
    cnr: null,
    "decision date": null,
    "disposal nature": null,
    judge: null,
    text: "",
  });

  // Statutes selection helpers
  const isStatuteChecked = (label: string) =>
    selectedStatutes.some((s) => s.trim().toLowerCase() === label.trim().toLowerCase());

  // Toggle helpers for statutes sources (with scope-change guard)
  const toggleStatute = (label: string) => {
    const next = selectedStatutes.includes(label)
      ? selectedStatutes.filter((s) => s !== label)
      : [...selectedStatutes, label];

    const currentScope = deriveStatutesScopeFromSources(selectedStatutes);
    const nextScope = deriveStatutesScopeFromSources(next);

    // WARN ONLY when the user is LEAVING the scope where filters were last applied.
    if (
      lastAppliedStatutesCtx &&
      haveAnyStatutesFilters() &&
      currentScope === lastAppliedStatutesCtx.scope &&
      nextScope !== lastAppliedStatutesCtx.scope
    ) {
      setPendingStatutes(next);
      setStatutesScopeWarnText(
        `Your filters were last applied in ${prettyStatutes(lastAppliedStatutesCtx.scope)}. ` +
        `You're switching to ${prettyStatutes(nextScope)}. Those filters may not match there. ` +
        `Recommended: clear filters and re-apply.`
      );
      setShowStatutesScopeWarn(true);
      return;
    }

    // otherwise change immediately
    setSelectedStatutes(next);
  };


  // Renderers for empty blocks (mirror your existing look & feel)
  function renderSCEmptyBlock(idx: number) {
    return [
      `### ${idx + 1}. Supreme Court — **file_name:** —`,
      `_No Supreme Court results matched your filters._`,
      ``,
      `**Case No.:** —`,
      `**Citation:** —`,
      `**Bench:** —`,
      `**Judgement By:** —`,
      `**Judgment date:** —`,
      ``,
      `---`,
      ``,
      `**Content:**`,
      `> —`,
    ].join("\n");
  }

  function renderHCEmptyBlock(r: any, idx: number) {
    const court = r["Court name"] || "—";
    return [
      `### ${idx + 1}. High Court — **Court name:** ${court}`,
      `_No High Court results matched your filters for the selected court(s)._`,
      ``,
      `**Case number:** —`,
      `**CNR:** —`,
      `**Decision date:** —`,
      `**Disposal nature:** —`,
      `**Judge:** —`,
      ``,
      `---`,
      ``,
      `**Text:**`,
      `> —`,
    ].join("\n");
  }

  const renderAnyRow = (r: any, i: number) => {
    if (r.__empty && r.source === "SC") return renderSCEmptyBlock(i);
    if (r.__empty && r.source === "HC") return renderHCEmptyBlock(r, i);
    return r.source === "SC" ? renderSCBlock(r, i) : renderHCBlock(r, i);
  };

  function makeQueryParams(baseQuery: string, pageSize: number): QueryParams {
    return {
      query: baseQuery,
      courts: selectedCourts,
      judge_name: normalizeJudgeNameInput(judgeName) || null,
      case_title: normalizeCaseTitleInput(caseName) || null,
      start_date: state[0]?.startDate ? format(state[0].startDate, "yyyy-MM-dd") : null,
      end_date: state[0]?.endDate ? format(state[0].endDate, "yyyy-MM-dd") : null,
      page_size: pageSize,
      keywords: [...keywords],
    };
  }

  function headerLine(fromIdx: number, count: number, total: number | undefined, sc?: number, hc?: number) {
    const from = total ? Math.min(fromIdx + 1, total) : fromIdx + 1;
    const to = total ? Math.min(fromIdx + count, total) : fromIdx + count;
    const totalStr = total != null ? ` of ${total}` : "";
    const breakdown =
      sc != null || hc != null ? ` _(SC: ${sc ?? 0}, HC: ${hc ?? 0})_` : "";
    return `**Showing ${from}–${to}${totalStr} results**${breakdown}.`;
  }

  // render rows with a starting index so numbering continues across pages
  function renderRowsChunk(rows: any[], startIndex: number) {
    return rows.map((r, i) => renderAnyRow(r, startIndex + i)).join(`\n\n---\n\n`);
  }

  // builds a friendly summary of whatever the user applied
  function buildAppliedSummary() {
    const parts: string[] = [];

    if (keywords.length) {
      parts.push(`Refined by keyword(s): ${keywords.join(", ")}`);
    }

    if (searchDomain === 'judgements') {
      if (judgeName.trim()) parts.push(`Judge: ${judgeName.trim()}`);
      if (caseName.trim()) parts.push(`Case title: ${caseName.trim()}`);

      const start = state[0]?.startDate;
      const end = state[0]?.endDate;
      if (start || end) {
        const s = start ? format(start, "PPP") : "—";
        const e = end ? format(end, "PPP") : "—";
        parts.push(`Date range: ${s} – ${e}`);
      }
      if (selectedCourts.length > 0) {
        parts.push(
          `Courts: ${selectedCourts.length > 3
            ? `${selectedCourts.slice(0, 3).join(", ")} +${selectedCourts.length - 3} more`
            : selectedCourts.join(", ")
          }`
        );
      }
    } else {
      if (sectionTitle.trim()) parts.push(`Search within Section Title: "${sectionTitle.trim()}"`);
      if (selectedStatutes.length) {
        parts.push(
          `Sources: ${selectedStatutes.length > 3
            ? `${selectedStatutes.slice(0, 3).join(", ")} +${selectedStatutes.length - 3} more`
            : selectedStatutes.join(", ")
          }`
        );
      }
    }

    return parts.join(" • ");
  }

  function pageList(current: number, total: number): (number | '…')[] {
    const pages: (number | '…')[] = [];
    const window = 1; // neighbors to show on each side
    if (total <= 10) {
      for (let i = 1; i <= total; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    if (current - window > 2) pages.push('…');
    for (let p = Math.max(2, current - window); p <= Math.min(total - 1, current + window); p++) {
      pages.push(p);
    }
    if (current + window < total - 1) pages.push('…');
    pages.push(total);
    return pages;
  }

  function normalizeCaseTitleInput(input: string): string {
    let s = (input || "").trim();

    // 1) Keep only the first line if a block was pasted
    s = s.split(/\r?\n/)[0];

    // 2) Strip common markdown/quote/list characters users might copy
    // (e.g., "**file_name:**", "### 1.", "> ")
    s = s
      .replace(/[*_`>]+/g, " ")           // markdown/bold/italic/backticks/blockquote
      .replace(/^\s*(?:[#\-\u2022>\s]*)?\d+[\.\)]\s*/, ""); // leading "1." / "1)" / bullets

    // 3) Drop a prefixed court heading like:
    //    "Supreme Court — ..." or "High Court of X — ..."
    //    (handles em/en dashes, hyphen, or colon)
    s = s.replace(/^(?:supreme\s+court|.*?high\s+court.*?)\s*(?:—|–|-|:)\s*/i, "");

    // 4) Split on separators to inspect label segments
    //    e.g. "file_name: R ..." -> ["file_name","R ..."]
    //    e.g. "Court name: Madras High Court — Title: ABC" -> ["Court name","Madras High Court","Title","ABC"]
    const segs = s.split(/\s*(?:—|–|-|:)\s*/).filter(Boolean);

    // 5) If we see "title" or "file_name" labels, keep the segment after the last such label
    let picked: string | null = null;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^(?:title|file[\s_-]*name)$/i.test(segs[i])) {
        picked = segs[i + 1];
      }
    }

    // 6) If not found, but we have an HC line like "Court name: ... — Title: ...",
    //    or any multi-segment line, prefer the last segment (most specific: the case title)
    if (!picked && segs.length > 1) {
      picked = segs[segs.length - 1];
    }

    // 7) Fall back to s as-is if nothing picked
    s = (picked || s).trim();

    // 8) Normalize "Vs./V./v." variants to " v "
    s = s.replace(/\bV(?:s\.?)?\b[\s\.]*/gi, " v ");

    // 9) Remove junk punctuation that hurts matching (keep letters, digits, spaces, (), /, &, -)
    // NOTE: avoid Unicode property escapes to keep TS targets happy
    s = s.replace(/[^\w\s()/&-]/g, " ");

    // 10) Collapse whitespace
    s = s.replace(/\s+/g, " ").trim();

    // 11) Empty/too-punctuated → empty string
    if (!/[A-Za-z0-9]/.test(s)) return "";

    return s;
  }

  // Clean up pasted judge names so they match SC/HC records
  function normalizeJudgeNameInput(input: string): string {
    // Keep it light: backend now does the heavy normalization (honorifics, initials, spacing).
    let s = (input || "").trim();

    // Keep only the first line if a block was pasted
    s = s.split(/\r?\n/)[0];

    // Normalize commas: "A ,B" -> "A, B", "A,  B" -> "A, B"
    s = s.replace(/\s*,\s*/g, ", ");

    // Collapse any remaining whitespace runs
    s = s.replace(/\s+/g, " ").trim();

    // Trim leading/trailing commas/spaces just in case
    s = s.replace(/^(?:,|\s)+|(?:,|\s)+$/g, "");

    return s;
  }

  function getFullBodyFromStatuteRow(r: any): string {
    // Only read the full field; do NOT fall back to snippet-like keys.
    return String(r["section text"] ?? r["Section Text"] ?? "");
  }

  // ─── Statutes strict refine helpers (AND + whole-word) ─────────────────────────
  function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function statutesSearchableText(r: any): string {
    const parts = [
      r["section text"] ?? r["Section Text"] ?? "",
      r["section title"] ?? r["Section Title"] ?? "",
      r["name of statute"] ?? r["Name of Statute"] ?? "",
      r["state name"] ?? r["State Name"] ?? "",
    ];
    return parts.join(" ");
  }

  function statutesMatchesAllKeywordsStrict(r: any, kws: string[]): boolean {
    if (!kws || kws.length === 0) return true;
    const hay = statutesSearchableText(r);
    return kws.every((kw) => {
      const trimmed = String(kw || "").trim();
      if (!trimmed) return true;
      const rx = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i");
      return rx.test(hay);
    });
  }

  function renderCentralActBlock(r: any, idx: number) {
    const statute = r["name of statute"] ?? r["Name of Statute"] ?? "—";
    const secNo = r["section number"] ?? r["Section Number"] ?? "—";
    const secTitle = r["section title"] ?? r["Section Title"] ?? "—";
    const body = toBlockquote(getFullBodyFromStatuteRow(r));

    return [
      `### ${idx + 1}. Central Act — ${statute}`,
      `**name of statute:** ${statute}`,
      `**section number:** ${secNo}`,
      `**section title:** ${secTitle}`,
      ``,
      `---`,
      ``,
      `**section text:**`,
      body,
    ].join("\n");
  }

  function renderStateActBlock(r: any, idx: number) {
    const stateName = r["state name"] ?? r["State Name"] ?? "—";
    const statute = r["name of statute"] ?? r["Name of Statute"] ?? "—";
    const secNo = r["section number"] ?? r["Section Number"] ?? "—";
    const secTitle = r["section title"] ?? r["Section Title"] ?? "—";
    const body = toBlockquote(getFullBodyFromStatuteRow(r)); // full text, no truncation

    return [
      `### ${idx + 1}. ${stateName} — ${statute}`,
      `**state name:** ${stateName}`,
      `**name of statute:** ${statute}`,
      `**section number:** ${secNo}`,
      `**section title:** ${secTitle}`,
      ``,
      `---`,
      ``,
      `**section text:**`,
      body,
    ].join("\n");
  }

  const renderAnyRowStatutes = (r: any, i: number) =>
    r.source === "CENTRAL" ? renderCentralActBlock(r, i) : renderStateActBlock(r, i);

  function renderRowsChunkStatutes(rows: any[], startIndex: number) {
    return rows.map((r, i) => renderAnyRowStatutes(r, startIndex + i)).join(`\n\n---\n\n`);
  }

  function headerLineStatutes(
    fromIdx: number,
    count: number,
    total: number | undefined,
    central?: number,
    state?: number
  ) {
    const from = total ? Math.min(fromIdx + 1, total) : fromIdx + 1;
    const to = total ? Math.min(fromIdx + count, total) : fromIdx + count;
    const totalStr = total != null ? ` of ${total}` : "";
    const breakdown =
      central != null || state != null
        ? ` _(Central: ${central ?? 0}, States: ${state ?? 0})_`
        : "";
    return `**Showing ${from}–${to}${totalStr} results**${breakdown}.`;
  }

  const clearAllConfigFields = () => {
    // refine
    setKeywords([]);
    setNewKeyword('');

    // advanced (judgements)
    setJudgeName('');
    setCaseName('');
    setState([{ startDate: null, endDate: null, key: 'selection' }]);
    setSelectedCourts([]);

    // advanced (statutes)
    setSectionTitle('');
    setSelectedStatutes([]);

    // local UI summaries / refine cache
    setRefineSnippetsByIndex({});
    setLastAppliedSummary('');
    setLastAppliedCtx(null);
    setLastAppliedStatutesCtx(null);

    toast.info("Refine search fields and advanced filters have been cleared.");
  };

  const applyConfiguration = async () => {
    console.log("Applying configuration:", {
      keywords,
      judgeName,
      caseName,
      dateRange: state,
      selectedQueryId,
      selectedCourts,
    });

    let lastResponseMeta: LegacyMeta = {};
    setIsSearching(true);

    // persistent loader
    const toastId = toast.loading("Retrieving…");

    // validation
    const noKeywords = keywords.length === 0;

    if (searchDomain === 'statutes') {
      const noSectionTitle = !sectionTitle.trim();
      const noSources = selectedStatutes.length === 0;

      if (noKeywords && noSectionTitle && noSources) {
        setPopup({
          type: "warning",
          message:
            'Please add keywords, or use Statutes Advanced: "Search within Section Title", or select Central/State sources.',
        });
        setIsSearching(false);
        toast.dismiss(toastId);
        return;
      }
    } else {
      const noJudgeName = !judgeName.trim();
      const noCaseName = !caseName.trim();
      const noDateRange = !(state[0]?.startDate && state[0]?.endDate);
      const noCourts = selectedCourts.length === 0;

      if (noKeywords && noJudgeName && noCaseName && noDateRange && noCourts) {
        setPopup({
          type: "warning",
          message:
            'Please add keywords, or use one of the Advanced filters (judge, case title, date, or select court(s)).',
        });
        setIsSearching(false);
        toast.dismiss(toastId);
        return;
      }
    }

    if (searchDomain === 'statutes') {
      try {
        const selectedQuery = selectedQueryId
          ? searchHistory.find((q) => q.id === selectedQueryId) ?? null
          : null;
        const qid = selectedQuery ? selectedQuery.id : Date.now().toString();

        const PAGE_SIZE = 20;
        const baseParams: StatutesQueryParams = {
          query: selectedQuery?.query ?? "",
          statutes: [...selectedStatutes],
          section_title: sectionTitle.trim() ? sectionTitle.trim() : null,
          page_size: PAGE_SIZE,
          keywords: [...keywords],
        };

        const useAdvanced = !!baseParams.section_title;
        const data = await fetchStatutesPage(baseParams, 1, useAdvanced);

        let pageResults: any[] = Array.isArray(data.results) ? data.results : [];

        // ===== strict refine on the page (AND + whole-word) =====
        if (keywords.length > 0 && pageResults.length > 0) {
          pageResults = pageResults.filter((r) => statutesMatchesAllKeywordsStrict(r, keywords));
        }
        // We don't display statute snippets by index, so clear this map
        setRefineSnippetsByIndex({});

        // history
        const meta: LegacyMeta = {
          central_total: data.central_total,
          state_total: data.state_total,
          total: data.total,
          page: 1,
          page_size: PAGE_SIZE,
          has_more: data.has_more,
        };
        if (selectedQuery) {
          setSearchHistory((prev) =>
            prev.map((q) => (q.id === qid ? { ...q, results: pageResults, meta } : q))
          );
        } else {
          // create a history record if user applied over "(no query)"
          setSearchHistory((prev) => [
            ...prev,
            { id: qid, query: baseParams.query || "(no query)", results: pageResults, meta },
          ]);
          setSelectedQueryId(qid);
        }

        setPager((prev) => ({
          ...prev,
          [qid]: {
            domain: 'statutes',
            currentPage: 1,
            totalPages: Math.max(1, Math.ceil((data.total ?? 0) / PAGE_SIZE)),
            total: data.total ?? undefined,
            pageSize: PAGE_SIZE,
            hasMore: !!data.has_more,
            params: { ...baseParams },
            cache: { 1: [...pageResults] },
          },
        }));

        const baseLabel = selectedQuery?.query ?? "(no query)";
        const appliedRefine = keywords.length > 0;
        const appliedAdvanced = !!baseParams.section_title;

        let searchLabel = baseLabel;
        if (appliedRefine && appliedAdvanced) searchLabel += " / refined & advanced search (statutes)";
        else if (appliedRefine) searchLabel += " / refined search (statutes)";
        else if (appliedAdvanced) searchLabel += " / advanced search (statutes)";

        const newMessageId = Date.now();

        const userMessage: Message = {
          messageId: newMessageId - 1,
          message: searchLabel,
          type: "user",
          files: [],
          toolCall: null,
          parentMessageId: SYSTEM_MESSAGE_ID,
        };

        const header = headerLineStatutes(
          0,
          pageResults.length,
          data.total,
          data.central_total,
          data.state_total
        );
        const displayBody = renderRowsChunkStatutes(pageResults, 0);

        const assistantMessage: Message = {
          messageId: newMessageId,
          message: `${header}\n\n${displayBody}`,
          type: "assistant",
          files: [],
          toolCall: null,
          parentMessageId: userMessage.messageId,
        };

        upsertToCompleteMessageMap({
          messages: [userMessage, assistantMessage],
          chatSessionId: currentSessionId(),
        });

        await setMessageAsLatest(assistantMessage.messageId);
        updateChatState("input");
        resetRegenerationState();

        // user-facing “Applied …” summary (statutes)
        const parts: string[] = [];
        if (keywords.length) parts.push(`Refined by keyword(s): ${keywords.join(", ")}`);
        if (baseParams.section_title) parts.push(`Search within Section Title: "${baseParams.section_title}"`);
        if (selectedStatutes.length) {
          const cap = selectedStatutes.length > 3
            ? `${selectedStatutes.slice(0, 3).join(", ")} +${selectedStatutes.length - 3} more`
            : selectedStatutes.join(", ");
          parts.push(`Sources: ${cap}`);
        }
        const summary = parts.join(" • ");
        setLastAppliedSummary(summary);
        toast.success(summary || "Applied.", { id: toastId, duration: 4000 });

        setLastAppliedStatutesCtx({
          scope: deriveStatutesScopeFromSources(selectedStatutes),
          sources: [...selectedStatutes],
        });

        // keep popup open
      } catch (err) {
        console.error("Statutes Apply Error:", err);
        setPopup({ type: "error", message: "Statutes refine/advanced failed." });
        toast.error("Something went wrong while retrieving statutes.", { id: toastId, duration: 5000 });
      } finally {
        setIsSearching(false);
      }
      return;
    }

    try {
      // determine path
      const hasAdvanced =
        !!judgeName ||
        !!caseName ||
        (state[0]?.startDate && state[0]?.endDate) ||
        selectedCourts.length > 0;

      const selectedQuery = selectedQueryId
        ? searchHistory.find((q) => q.id === selectedQueryId) ?? null
        : null;

      let activeQueryId: string | null = selectedQuery?.id ?? selectedQueryId;

      let pageResults: any[] = [];
      const baseLabel = selectedQuery?.query ?? "(no query)";

      // ===== PATH A: refine-only on current page (no requery) =====
      if (selectedQuery && !hasAdvanced) {
        pageResults = [...selectedQuery.results];
        lastResponseMeta = selectedQuery.meta ?? {};

        // keep pager's keywords in sync for later "Show more"
        if (selectedQueryId && pager[selectedQueryId] && pager[selectedQueryId]!.domain === 'judgements') {
          setPager((prev) => {
            const cur = prev[selectedQueryId] as JudgementsPagerEntry;
            return {
              ...prev,
              [selectedQueryId]: {
                ...cur,
                params: { ...cur.params, keywords: [...keywords] },
              },
            };
          });
        }

        // ===== PATH B: advanced or no selected query → call backend page 1 =====
      } else {
        const PAGE_SIZE = 20;
        const baseParams = makeQueryParams(selectedQuery?.query ?? "", PAGE_SIZE);

        // Detect the problematic combo: SC + any HC + (judge_name || case_title || date range)
        const mixedAdvanced =
          bothCourtsSelected(baseParams.courts) &&
          (!!baseParams.judge_name || !!baseParams.case_title || (!!baseParams.start_date && !!baseParams.end_date));

        const qid = selectedQuery ? selectedQuery.id : Date.now().toString();

        if (mixedAdvanced) {
          // --- Split path: fetch SC-only and HC-only, then merge the first page ---
          const { scParams, hcParams } = splitMixedParams(baseParams);

          const [scData, hcData] = await Promise.all([
            scParams ? fetchJudgementsPage(scParams, 1) : Promise.resolve({ results: [], total: 0 }),
            hcParams ? fetchJudgementsPage(hcParams, 1) : Promise.resolve({ results: [], total: 0 }),
          ]);

          const scTotal = Number(scData.total || 0);
          const hcTotal = Number(hcData.total || 0);
          const grandTotal = scTotal + hcTotal;

          // Build combined first page (SC first, then HC) capped to PAGE_SIZE
          const combinedFirst = [
            ...(Array.isArray(scData.results) ? scData.results : []),
            ...(Array.isArray(hcData.results) ? hcData.results : []),
          ].slice(0, PAGE_SIZE);

          pageResults = combinedFirst;
          lastResponseMeta = {
            sc_total: scTotal,
            hc_total: hcTotal,
            total: grandTotal,
            page: 1,
            page_size: PAGE_SIZE,
            has_more: grandTotal > PAGE_SIZE,
          };

          // Upsert history record
          if (selectedQuery) {
            setSearchHistory((prev) =>
              prev.map((q) => (q.id === qid ? { ...q, results: pageResults, meta: lastResponseMeta } : q))
            );
          } else {
            setSearchHistory((prev) => [...prev, { id: qid, query: baseLabel, results: pageResults, meta: lastResponseMeta }]);
            setSelectedQueryId(qid);
          }

          setPager((prev) => ({
            ...prev,
            [qid]: {
              domain: 'judgements',
              currentPage: 1,
              totalPages: Math.max(1, Math.ceil(grandTotal / PAGE_SIZE)),
              total: grandTotal,
              pageSize: PAGE_SIZE,
              hasMore: grandTotal > PAGE_SIZE,
              params: { ...baseParams, keywords: [...keywords] },
              cache: { 1: [...pageResults] },
              mixedSplit: {
                sc: scParams ? { total: scTotal, params: scParams, cache: { 1: Array.isArray(scData.results) ? [...scData.results] : [] } } : undefined,
                hc: hcParams ? { total: hcTotal, params: hcParams, cache: { 1: Array.isArray(hcData.results) ? [...hcData.results] : [] } } : undefined,
              },
            },
          }));

        } else {
          // --- Original single-call path (SC-only or HC-only or mixed without advanced fields) ---
          const advancedResponse = await fetch("/api/legacysearch/judgements/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...baseParams, page: 1 }),
          });
          if (!advancedResponse.ok) throw new Error("Advanced search failed");

          const adv = await advancedResponse.json(); // { results, total, sc_total, hc_total, page, page_size, has_more }
          pageResults = adv.results;
          lastResponseMeta = {
            sc_total: adv.sc_total,
            hc_total: adv.hc_total,
            total: adv.total,
            page: 1,
            page_size: PAGE_SIZE,
            has_more: adv.has_more,
          };

          if (selectedQuery) {
            setSearchHistory((prev) =>
              prev.map((q) => (q.id === qid ? { ...q, results: pageResults, meta: lastResponseMeta } : q))
            );
          } else {
            setSearchHistory((prev) => [...prev, { id: qid, query: baseLabel, results: pageResults, meta: lastResponseMeta }]);
            setSelectedQueryId(qid);
          }

          setPager((prev) => ({
            ...prev,
            [qid]: {
              domain: 'judgements',
              currentPage: 1,
              totalPages: Math.max(1, Math.ceil((adv.total ?? 0) / PAGE_SIZE)),
              total: adv.total ?? undefined,
              pageSize: PAGE_SIZE,
              hasMore: !!adv.has_more,
              params: { ...baseParams, keywords: [...keywords] },
              cache: { 1: [...pageResults] },
            },
          }));
        }
      }

      // ===== refine/highlight (applies to BOTH paths) =====
      let refineSnippetsMap: Record<number, { match_count: number; snippets: string[] }> = {};
      let filteredResults: any[] = [];

      if (keywords.length > 0 && pageResults.length > 0) {
        const refineResponse = await fetch("/api/legacysearch/judgements/refine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            results: pageResults,
            keywords,
            max_snippets_per_doc: 3,
            snippet_window: 120,
          }),
        });

        if (refineResponse.ok) {
          const { docs } = await refineResponse.json();
          docs.forEach((d: any, i: number) => {
            if (d.match_count > 0) {
              refineSnippetsMap[filteredResults.length] = {
                match_count: d.match_count,
                snippets: d.snippets || [],
              };
              filteredResults.push(pageResults[i]);
            }
          });
        }

        pageResults = filteredResults;
      }
      setRefineSnippetsByIndex(refineSnippetsMap);
      // Keep history in sync with the actually displayed (possibly refined) page results
      if (activeQueryId) {
        setSearchHistory((prev) =>
          prev.map((q) =>
            q.id === activeQueryId
              ? { ...q, results: [...pageResults], meta: q.meta ?? lastResponseMeta }
              : q
          )
        );
      }

      // empty after refine → emit empty state & stop
      if (keywords.length > 0 && pageResults.length === 0) {
        const newMessageId = Date.now();

        const userMessage: Message = {
          messageId: newMessageId - 1,
          message: `${baseLabel} / refined search`,
          type: "user",
          files: [],
          toolCall: null,
          parentMessageId: SYSTEM_MESSAGE_ID,
        };

        const assistantMessage: Message = {
          messageId: newMessageId,
          message: `No results matched your keyword(s): **${keywords.join(", ")}**.`,
          type: "assistant",
          files: [],
          toolCall: null,
          parentMessageId: userMessage.messageId,
        };

        upsertToCompleteMessageMap({
          messages: [userMessage, assistantMessage],
          chatSessionId: currentSessionId(),
        });

        await setMessageAsLatest(assistantMessage.messageId);
        updateChatState("input");
        resetRegenerationState();
        setIsSearching(false);
        toast(`No results matched your keyword(s): ${keywords.join(", ")}`, {
          id: toastId,
          icon: "ℹ️",
          duration: 4000,
        });
        return;
      }

      // ===== build & emit message (works for BOTH paths) =====
      const appliedRefine = keywords.length > 0;
      const appliedAdvanced = hasAdvanced;

      let searchLabel = baseLabel;
      if (appliedRefine && appliedAdvanced) searchLabel += " / refined & advanced search";
      else if (appliedRefine) searchLabel += " / refined search";
      else if (appliedAdvanced) searchLabel += " / advanced search";

      const newMessageId = Date.now();

      const userMessage: Message = {
        messageId: newMessageId - 1,
        message: searchLabel,
        type: "user",
        files: [],
        toolCall: null,
        parentMessageId: SYSTEM_MESSAGE_ID,
      };

      let displayResults = [...pageResults];

      if (searchDomain === 'judgements' && bothCourtsSelected(selectedCourts)) {
        const hasSC = displayResults.some((r) => r.source === "SC");
        const hasHC = displayResults.some((r) => r.source === "HC");
        const scTotal = lastResponseMeta.sc_total ?? 0;
        const hcTotal = lastResponseMeta.hc_total ?? 0;
        if (!hasSC && scTotal === 0) displayResults.unshift(buildEmptySCRow());
        if (!hasHC && hcTotal === 0) displayResults.push(buildEmptyHCRow(highCourtsFrom(selectedCourts)));
      }

      const header = headerLine(
        0,
        pageResults.length,
        lastResponseMeta.total,
        searchDomain === 'judgements' ? lastResponseMeta.sc_total : undefined,
        searchDomain === 'judgements' ? lastResponseMeta.hc_total : undefined
      );
      const displayBody = renderRowsChunk(displayResults, 0);

      const assistantMessage: Message = {
        messageId: newMessageId,
        message: `${header}\n\n${displayBody}`,
        type: "assistant",
        files: [],
        toolCall: null,
        parentMessageId: userMessage.messageId,
      };

      upsertToCompleteMessageMap({
        messages: [userMessage, assistantMessage],
        chatSessionId: currentSessionId(),
      });

      await setMessageAsLatest(assistantMessage.messageId);
      updateChatState("input");
      resetRegenerationState();

      const summary = buildAppliedSummary();
      setLastAppliedSummary(summary);
      toast.success(summary || "Applied.", { id: toastId, duration: 4000 });

      setLastAppliedCtx({
        scope: deriveScopeFromCourts(selectedCourts),
        courts: [...selectedCourts],
      });
      // keep popup open

    } catch (error) {
      console.error("Refine/Advanced Error:", error);
      updateChatState("input");
      setPopup({ type: "error", message: "Search refine/advanced failed." });
      toast.error("Something went wrong while retrieving results.", {
        id: toastId,
        duration: 5000,
      });
    } finally {
      setIsSearching(false);
    }
  };

  async function goToPage(queryId: string, page: number) {
    const entry = pager[queryId];
    if (!entry || entry.domain !== 'judgements') {
      toast.info('Paging applies to Judgments. Use "Show more" in Statutes.');
      return;
    }
    const jEntry = entry; // JudgementsPagerEntry

    if (page < 1 || page > jEntry.totalPages) return;
    if (page === jEntry.currentPage && jEntry.cache?.[page]) return; // already on it

    // ─────────────────────────────────────────────────────────────
    // INSERT START: MIXED SPLIT PAGINATION (SC first, then HC)
    // This short-circuits the normal path whenever mixedSplit is present.
    if (entry.mixedSplit) {
      try {
        setLoadingPageFor(`${queryId}:${page}`);

        // 1) Use combined cache if available
        const cachedCombined = entry.cache?.[page];
        let newPageResults: any[] = Array.isArray(cachedCombined) ? [...cachedCombined] : [];

        if (newPageResults.length === 0) {
          // 2) Assemble from per-source caches (fetching missing pages as needed)
          const { rows, totals } = await assembleMixedPage(entry, page);
          newPageResults = rows;

          // 3) Cache the combined page
          setPager((prev) => ({
            ...prev,
            [queryId]: {
              ...prev[queryId],
              cache: { ...(prev[queryId].cache || {}), [page]: [...newPageResults] },
            },
          }));

          // 4) Update totals snapshot for this page
          setSearchHistory((prev) =>
            prev.map((q) =>
              q.id === queryId
                ? {
                  ...q,
                  results: [...newPageResults],
                  meta: {
                    sc_total: totals.sc_total,
                    hc_total: totals.hc_total,
                    total: totals.total,
                    page,
                    page_size: entry.pageSize,
                    has_more: page < entry.totalPages,
                  },
                }
                : q
            )
          );
        } else {
          // keep meta coherent when serving from combined cache
          const scT = entry.mixedSplit.sc?.total ?? 0;
          const hcT = entry.mixedSplit.hc?.total ?? 0;
          const tot = scT + hcT;
          setSearchHistory((prev) =>
            prev.map((q) =>
              q.id === queryId
                ? {
                  ...q,
                  results: [...newPageResults],
                  meta: {
                    sc_total: scT,
                    hc_total: hcT,
                    total: tot,
                    page,
                    page_size: entry.pageSize,
                    has_more: page < entry.totalPages,
                  },
                }
                : q
            )
          );
        }

        // 5) Apply refine keywords to the combined page if needed
        if (entry.params.keywords.length > 0 && newPageResults.length > 0) {
          const refineResp = await fetch("/api/legacysearch/judgements/refine", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              results: newPageResults,
              keywords: entry.params.keywords,
              max_snippets_per_doc: 3,
              snippet_window: 120,
            }),
          });
          if (refineResp.ok) {
            const { docs } = await refineResp.json();
            const filtered: any[] = [];
            docs.forEach((d: any, i: number) => {
              if (d.match_count > 0) filtered.push(newPageResults[i]);
            });
            newPageResults = filtered;
          }
        }

        // 6) Update pager current page
        setPager((prev) => ({
          ...prev,
          [queryId]: { ...prev[queryId], currentPage: page, hasMore: page < prev[queryId].totalPages },
        }));

        // 7) Emit UI message (same presentation as your normal path)
        const scTotal = entry.mixedSplit.sc?.total ?? 0;
        const hcTotal = entry.mixedSplit.hc?.total ?? 0;
        const totalsAll = scTotal + hcTotal;

        const newMessageId = Date.now();
        const userMessage: Message = {
          messageId: newMessageId - 1,
          message: `Go to page ${page}`,
          type: "user",
          files: [],
          toolCall: null,
          parentMessageId: SYSTEM_MESSAGE_ID,
        };

        const startIndex = (page - 1) * entry.pageSize;
        const header = headerLine(startIndex, newPageResults.length, totalsAll, scTotal, hcTotal);

        let displayResults = [...newPageResults];
        if (bothCourtsSelected(entry.params.courts)) {
          const hasSC = displayResults.some((r) => r.source === "SC");
          const hasHC = displayResults.some((r) => r.source === "HC");
          if (!hasSC && scTotal === 0) displayResults.unshift(buildEmptySCRow());
          if (!hasHC && hcTotal === 0) displayResults.push(buildEmptyHCRow(highCourtsFrom(entry.params.courts)));
        }

        const body = renderRowsChunk(displayResults, startIndex);

        const assistantMessage: Message = {
          messageId: newMessageId,
          message: `${header}\n\n${body}`,
          type: "assistant",
          files: [],
          toolCall: null,
          parentMessageId: userMessage.messageId,
        };

        upsertToCompleteMessageMap({
          messages: [userMessage, assistantMessage],
          chatSessionId: currentSessionId(),
        });

        await setMessageAsLatest(assistantMessage.messageId);
        updateChatState("input");
        resetRegenerationState();
      } catch (e) {
        console.error("Paging error (mixed):", e);
        toast.error("Could not load that page. Please try again.");
      } finally {
        setLoadingPageFor(null);
      }
      return; // IMPORTANT: don't fall through to the normal path
    }
    try {
      setLoadingPageFor(`${queryId}:${page}`);

      // 1) Use cache if we have it
      const cached = entry.cache?.[page];
      let newPageResults: any[] = Array.isArray(cached) ? [...cached] : [];
      const usedCache = Array.isArray(cached);
      let totals = {
        total: entry.total,
        sc_total: searchDomain === 'judgements' ? searchHistory.find(q => q.id === queryId)?.meta?.sc_total : undefined,
        hc_total: searchDomain === 'judgements' ? searchHistory.find(q => q.id === queryId)?.meta?.hc_total : undefined,
      };

      // 2) Fetch if not cached
      if (!usedCache) {
        const resp = await fetch("/api/legacysearch/judgements/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...entry.params,
            page,
          }),
        });
        if (!resp.ok) throw new Error("Paging failed");
        const data = await resp.json(); // { results, total, sc_total, hc_total, has_more }
        newPageResults = Array.isArray(data.results) ? data.results : [];

        // Apply refine to this page if needed
        if (entry.params.keywords.length > 0 && newPageResults.length > 0) {
          const refineResp = await fetch("/api/legacysearch/judgements/refine", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              results: newPageResults,
              keywords: entry.params.keywords,
              max_snippets_per_doc: 3,
              snippet_window: 120,
            }),
          });
          if (refineResp.ok) {
            const { docs } = await refineResp.json();
            const filtered: any[] = [];
            docs.forEach((d: any, i: number) => {
              if (d.match_count > 0) filtered.push(newPageResults[i]);
            });
            newPageResults = filtered;
          }
        }

        totals = {
          total: data.total,
          sc_total: data.sc_total,
          hc_total: data.hc_total,
        };

        // update cache for this page
        setPager((prev) => ({
          ...prev,
          [queryId]: {
            ...prev[queryId],
            cache: { ...(prev[queryId].cache || {}), [page]: [...newPageResults] },
          },
        }));
      }

      // 3) Replace results in history with *this page only*
      setSearchHistory((prev) =>
        prev.map((q) =>
          q.id === queryId
            ? {
              ...q,
              results: [...newPageResults],
              meta: {
                sc_total: totals.sc_total,
                hc_total: totals.hc_total,
                total: totals.total,
                page,
                page_size: entry.pageSize,
                has_more: page < entry.totalPages,
              },
            }
            : q
        )
      );

      // 4) Update pager current page
      setPager((prev) => ({
        ...prev,
        [queryId]: { ...prev[queryId], currentPage: page, hasMore: page < prev[queryId].totalPages },
      }));

      // 5) Emit the page chunk as a new assistant message
      const newMessageId = Date.now();
      const userMessage: Message = {
        messageId: newMessageId - 1,
        message: `Go to page ${page}`,
        type: "user",
        files: [],
        toolCall: null,
        parentMessageId: SYSTEM_MESSAGE_ID,
      };

      const startIndex = (page - 1) * entry.pageSize;
      const header = headerLine(
        startIndex,
        newPageResults.length,
        totals.total,
        totals.sc_total,
        totals.hc_total
      );

      // If both SC+HC were requested and one side has zero, inject empties on first load of that page
      let displayResults = [...newPageResults];
      if (bothCourtsSelected(entry.params.courts)) {
        const hasSC = displayResults.some((r) => r.source === "SC");
        const hasHC = displayResults.some((r) => r.source === "HC");
        const scTotal = totals.sc_total ?? 0;
        const hcTotal = totals.hc_total ?? 0;
        if (!hasSC && scTotal === 0) displayResults.unshift(buildEmptySCRow());
        if (!hasHC && hcTotal === 0) displayResults.push(buildEmptyHCRow(highCourtsFrom(entry.params.courts)));
      }

      const body = renderRowsChunk(displayResults, startIndex);

      const assistantMessage: Message = {
        messageId: newMessageId,
        message: `${header}\n\n${body}`,
        type: "assistant",
        files: [],
        toolCall: null,
        parentMessageId: userMessage.messageId,
      };

      upsertToCompleteMessageMap({
        messages: [userMessage, assistantMessage],
        chatSessionId: currentSessionId(),
      });

      await setMessageAsLatest(assistantMessage.messageId);
      updateChatState("input");
      resetRegenerationState();
    } catch (e) {
      console.error("Paging error:", e);
      toast.error("Could not load that page. Please try again.");
    } finally {
      setLoadingPageFor(null);
    }
  }

  async function goToPageStatutes(queryId: string, page: number) {
    const entry = pager[queryId];
    if (!entry || entry.domain !== 'statutes') return;
    const sEntry = entry; // StatutesPagerEntry

    if (page < 1 || page > sEntry.totalPages) return;
    if (page === sEntry.currentPage && sEntry.cache?.[page]) return; // already on it

    try {
      setLoadingPageFor(`${queryId}:${page}`);

      // 1) Use cache if present
      const cached = sEntry.cache?.[page];
      let newPageResults: any[] = Array.isArray(cached) ? [...cached] : [];
      const usedCache = Array.isArray(cached);

      // We’ll keep these to render header
      let totals = {
        total: sEntry.total,
        central_total: searchHistory.find(q => q.id === queryId)?.meta?.central_total,
        state_total: searchHistory.find(q => q.id === queryId)?.meta?.state_total,
      };

      // 2) Fetch if not cached
      if (!usedCache) {
        const params = sEntry.params; // StatutesQueryParams
        const useAdvanced = !!params.section_title;
        const resp = await fetchStatutesPage(params, page, useAdvanced);

        newPageResults = Array.isArray(resp.results) ? resp.results : [];

        // Apply refine on this page if needed
        if ((params.keywords?.length || 0) > 0 && newPageResults.length > 0) {
          newPageResults = newPageResults.filter((r) => statutesMatchesAllKeywordsStrict(r, params.keywords));
        }

        totals = {
          total: resp.total,
          central_total: resp.central_total,
          state_total: resp.state_total,
        };

        // cache page
        setPager(prev => ({
          ...prev,
          [queryId]: {
            ...prev[queryId],
            cache: { ...(prev[queryId].cache || {}), [page]: [...newPageResults] },
          },
        }));
      }

      // 3) Replace results in history with *this page only*
      setSearchHistory(prev =>
        prev.map(q =>
          q.id === queryId
            ? {
              ...q,
              results: [...newPageResults],
              meta: {
                central_total: totals.central_total,
                state_total: totals.state_total,
                total: totals.total,
                page,
                page_size: sEntry.pageSize,
                has_more: page < sEntry.totalPages,
              },
            }
            : q
        )
      );

      // 4) Update pager current page
      setPager(prev => ({
        ...prev,
        [queryId]: { ...prev[queryId], currentPage: page, hasMore: page < prev[queryId].totalPages },
      }));

      // 5) Emit the page chunk (mirrors judgements)
      const newMessageId = Date.now();
      const userMessage: Message = {
        messageId: newMessageId - 1,
        message: `Go to page ${page}`,
        type: "user",
        files: [],
        toolCall: null,
        parentMessageId: SYSTEM_MESSAGE_ID,
      };

      const startIndex = (page - 1) * sEntry.pageSize;
      const header = headerLineStatutes(
        startIndex,
        newPageResults.length,
        totals.total,
        totals.central_total,
        totals.state_total
      );
      const body = renderRowsChunkStatutes(newPageResults, startIndex);

      const assistantMessage: Message = {
        messageId: newMessageId,
        message: `${header}\n\n${body}`,
        type: "assistant",
        files: [],
        toolCall: null,
        parentMessageId: userMessage.messageId,
      };

      upsertToCompleteMessageMap({
        messages: [userMessage, assistantMessage],
        chatSessionId: currentSessionId(),
      });

      await setMessageAsLatest(assistantMessage.messageId);
      updateChatState("input");
      resetRegenerationState();
    } catch (e) {
      console.error("Paging error (statutes):", e);
      toast.error("Could not load that page. Please try again.");
    } finally {
      setLoadingPageFor(null);
    }
  }

  const toggleProSearch = () => {
    Cookies.set(
      PRO_SEARCH_TOGGLED_COOKIE_NAME,
      String(!proSearchEnabled).toLocaleLowerCase()
    );
    setProSearchEnabled(!proSearchEnabled);
  };

  const isInitialLoad = useRef(true);
  const [userSettingsToggled, setUserSettingsToggled] = useState(false);

  const { assistants: availableAssistants, pinnedAssistants } = useAssistants();

  const [showApiKeyModal, setShowApiKeyModal] = useState(
    !shouldShowWelcomeModal
  );

  const { user, isAdmin } = useUser();
  const slackChatId = searchParams?.get("slackChatId");
  const existingChatIdRaw = searchParams?.get("chatId");

  const [showHistorySidebar, setShowHistorySidebar] = useState(false);

  const existingChatSessionId = existingChatIdRaw ? existingChatIdRaw : null;

  const selectedChatSession = chatSessions.find(
    (chatSession) => chatSession.id === existingChatSessionId
  );

  useEffect(() => {
    if (user?.is_anonymous_user) {
      Cookies.set(
        SIDEBAR_TOGGLED_COOKIE_NAME,
        String(!sidebarVisible).toLocaleLowerCase()
      );
      toggle(false);
    }
  }, [user]);

  const processSearchParamsAndSubmitMessage = (searchParamsString: string) => {
    const newSearchParams = new URLSearchParams(searchParamsString);
    const message = newSearchParams?.get("user-prompt");

    filterManager.buildFiltersFromQueryString(
      newSearchParams.toString(),
      availableSources,
      documentSets.map((ds) => ds.name),
      tags
    );

    const fileDescriptorString = newSearchParams?.get(SEARCH_PARAM_NAMES.FILES);
    const overrideFileDescriptors: FileDescriptor[] = fileDescriptorString
      ? JSON.parse(decodeURIComponent(fileDescriptorString))
      : [];

    newSearchParams.delete(SEARCH_PARAM_NAMES.SEND_ON_LOAD);

    router.replace(`?${newSearchParams.toString()}`, { scroll: false });

    // If there's a message, submit it
    if (message) {
      setSubmittedMessage(message);
      onSubmit({ messageOverride: message, overrideFileDescriptors });
    }
  };

  const chatSessionIdRef = useRef<string | null>(existingChatSessionId);

  // Only updates on session load (ie. rename / switching chat session)
  // Useful for determining which session has been loaded (i.e. still on `new, empty session` or `previous session`)
  const loadedIdSessionRef = useRef<string | null>(existingChatSessionId);

  const existingChatSessionAssistantId = selectedChatSession?.persona_id;
  const [selectedAssistant, setSelectedAssistant] = useState<
    Persona | undefined
  >(
    // NOTE: look through available assistants here, so that even if the user
    // has hidden this assistant it still shows the correct assistant when
    // going back to an old chat session
    existingChatSessionAssistantId !== undefined
      ? availableAssistants.find(
        (assistant) => assistant.id === existingChatSessionAssistantId
      )
      : defaultAssistantId !== undefined
        ? availableAssistants.find(
          (assistant) => assistant.id === defaultAssistantId
        )
        : undefined
  );
  // Gather default temperature settings
  const search_param_temperature = searchParams?.get(
    SEARCH_PARAM_NAMES.TEMPERATURE
  );

  const setSelectedAssistantFromId = (assistantId: number) => {
    // NOTE: also intentionally look through available assistants here, so that
    // even if the user has hidden an assistant they can still go back to it
    // for old chats
    setSelectedAssistant(
      availableAssistants.find((assistant) => assistant.id === assistantId)
    );
  };

  const [alternativeAssistant, setAlternativeAssistant] =
    useState<Persona | null>(null);

  const [presentingDocument, setPresentingDocument] =
    useState<MinimalOnyxDocument | null>(null);

  // Current assistant is decided based on this ordering
  // 1. Alternative assistant (assistant selected explicitly by user)
  // 2. Selected assistant (assistnat default in this chat session)
  // 3. First pinned assistants (ordered list of pinned assistants)
  // 4. Available assistants (ordered list of available assistants)
  // Relevant test: `live_assistant.spec.ts`
  const liveAssistant: Persona | undefined = useMemo(
    () =>
      alternativeAssistant ||
      selectedAssistant ||
      pinnedAssistants[0] ||
      availableAssistants[0],
    [
      alternativeAssistant,
      selectedAssistant,
      pinnedAssistants,
      availableAssistants,
    ]
  );

  const llmManager = useLlmManager(
    llmProviders,
    selectedChatSession,
    liveAssistant
  );

  const noAssistants = liveAssistant == null || liveAssistant == undefined;

  const availableSources: ValidSources[] = useMemo(() => {
    return ccPairs.map((ccPair) => ccPair.source);
  }, [ccPairs]);

  const sources: SourceMetadata[] = useMemo(() => {
    const uniqueSources = Array.from(new Set(availableSources));
    return uniqueSources.map((source) => getSourceMetadata(source));
  }, [availableSources]);

  const stopGenerating = () => {
    const currentSession = currentSessionId();
    const controller = abortControllers.get(currentSession);
    if (controller) {
      controller.abort();
      setAbortControllers((prev) => {
        const newControllers = new Map(prev);
        newControllers.delete(currentSession);
        return newControllers;
      });
    }

    const lastMessage = messageHistory[messageHistory.length - 1];
    if (
      lastMessage &&
      lastMessage.type === "assistant" &&
      lastMessage.toolCall &&
      lastMessage.toolCall.tool_result === undefined
    ) {
      const newCompleteMessageMap = new Map(
        currentMessageMap(completeMessageDetail)
      );
      const updatedMessage = { ...lastMessage, toolCall: null };
      newCompleteMessageMap.set(lastMessage.messageId, updatedMessage);
      updateCompleteMessageDetail(currentSession, newCompleteMessageMap);
    }

    updateChatState("input", currentSession);
  };

  // this is for "@"ing assistants

  // this is used to track which assistant is being used to generate the current message
  // for example, this would come into play when:
  // 1. default assistant is `Onyx`
  // 2. we "@"ed the `GPT` assistant and sent a message
  // 3. while the `GPT` assistant message is generating, we "@" the `Paraphrase` assistant
  const [alternativeGeneratingAssistant, setAlternativeGeneratingAssistant] =
    useState<Persona | null>(null);

  // used to track whether or not the initial "submit on load" has been performed
  // this only applies if `?submit-on-load=true` or `?submit-on-load=1` is in the URL
  // NOTE: this is required due to React strict mode, where all `useEffect` hooks
  // are run twice on initial load during development
  const submitOnLoadPerformed = useRef<boolean>(false);

  const { popup, setPopup } = usePopup();

  // fetch messages for the chat session
  const [isFetchingChatMessages, setIsFetchingChatMessages] = useState(
    existingChatSessionId !== null
  );

  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    Prism.highlightAll();
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (showDatePopup) {
      const { overflow } = document.body.style;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = overflow; };
    }
  }, [showDatePopup]);

  useEffect(() => {
    // Prewarm from localStorage on first mount (no fetch here)
    const local = readCachedCourts();
    if (local) {
      courtsCacheRef.current = local;
      setCourtsList((prev) => (prev?.length ? prev : local));
    }
    // no deps -> run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedQueryId) return;
    const dom = pager[selectedQueryId]?.domain;
    if (dom && dom !== searchDomain) {
      setSelectedQueryId(null);
    }
  }, [searchDomain, selectedQueryId, pager]);

  useEffect(() => {
    const isLegacy = selectedAssistant?.name === "Legacy Search";
    if (!isLegacy) {
      // leaving Legacy Search → drop the selection so the pager can't render when you return
      setSelectedQueryId(null);
      setLoadingPageFor(null);
      setRefineSnippetsByIndex({});
    }
  }, [selectedAssistant?.name]);

  useEffect(() => {
    if (selectedQueryId && !searchHistory.some(q => q.id === selectedQueryId)) {
      setSelectedQueryId(null);
    }
  }, [searchHistory, selectedQueryId]);

  const selectedHistory = selectedQueryId
    ? searchHistory.find(q => q.id === selectedQueryId)
    : null;

  const showLegacyPager =
    selectedAssistant?.name === "Legacy Search" &&
    searchDomain === "judgements" &&
    !!selectedHistory &&
    !!pager[selectedHistory.id] &&
    pager[selectedHistory.id].domain === 'judgements' &&     // guard
    (selectedHistory.results?.length ?? 0) > 0 &&
    pager[selectedHistory.id].totalPages > 1 &&
    !showPopup &&
    !isSearching;

  const showLegacyPagerStatutes =
    selectedAssistant?.name === "Legacy Search" &&
    searchDomain === "statutes" &&
    !!selectedHistory &&
    !!pager[selectedHistory.id] &&
    pager[selectedHistory.id].domain === 'statutes' &&
    (selectedHistory.results?.length ?? 0) > 0 &&
    pager[selectedHistory.id].totalPages > 1 &&
    !showPopup &&
    !isSearching;

  useEffect(() => {
    if (selectedAssistant?.name !== "Legacy Search" || searchDomain !== 'judgements') return;

    let cancelled = false;

    // 1) Hydrate immediately from in-memory or localStorage; fallback already in state.
    const cachedLocal = courtsCacheRef.current || readCachedCourts();
    if (cachedLocal && !cancelled) {
      courtsCacheRef.current = cachedLocal;
      setCourtsList(cachedLocal);
    } else {
      // keep HC_FALLBACK already in state; do NOT block the UI
      setCourtsList(HC_FALLBACK);
    }

    // 2) Background refresh with a short timeout (no visible loader needed)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // abort after 2.5s

    (async () => {
      try {
        // Only show the loading label if we really have nothing (rare in our setup)
        if (
          courtsList.length === 0 &&
          !(courtsCacheRef.current || cachedLocal || HC_FALLBACK.length)
        ) {
          setLoadingCourts(true);
        }

        const res = await fetch("/api/legacysearch/judgements/courts", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Failed to load courts");
        const data = await res.json(); // { supreme, high_courts }

        const hc = Array.isArray(data.high_courts) ? data.high_courts : [];
        const finalList = hc.length ? hc : HC_FALLBACK;

        if (!cancelled && finalList && finalList.length) {
          courtsCacheRef.current = finalList;
          setCourtsList(finalList);
          writeCachedCourts(finalList);
        }
      } catch (e) {
        // Network slow/aborted/etc. — user still sees fallback/cached list instantly
        console.error("Load courts error:", e);
      } finally {
        if (!cancelled) setLoadingCourts(false);
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssistant?.name, searchDomain]);

  useEffect(() => {
    if (selectedAssistant?.name !== "Legacy Search" || searchDomain !== 'statutes') return;

    let cancelled = false;

    // 1) Hydrate from localStorage or ref
    const cachedLocal = statesCacheRef.current || readCachedStates();
    if (cachedLocal && !cancelled) {
      statesCacheRef.current = cachedLocal;
      setStatesList(cachedLocal);
    }

    // 2) Background refresh
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    (async () => {
      try {
        if (!cachedLocal) setLoadingStates(true);

        const res = await fetch("/api/legacysearch/statutes/states", { signal: controller.signal });
        if (!res.ok) throw new Error("Failed to load states");
        const data = await res.json(); // { central: "Central Acts", states: [...] }

        const finalList: string[] = Array.isArray(data.states) ? data.states : [];
        if (!cancelled && finalList.length) {
          statesCacheRef.current = finalList;
          setStatesList(finalList);
          writeCachedStates(finalList);
        }
      } catch (e) {
        console.error("Load states error:", e);
      } finally {
        if (!cancelled) setLoadingStates(false);
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [selectedAssistant?.name, searchDomain]);

  useEffect(() => {
    const priorChatSessionId = chatSessionIdRef.current;
    const loadedSessionId = loadedIdSessionRef.current;
    chatSessionIdRef.current = existingChatSessionId;
    loadedIdSessionRef.current = existingChatSessionId;

    textAreaRef.current?.focus();

    // only clear things if we're going from one chat session to another
    const isChatSessionSwitch = existingChatSessionId !== priorChatSessionId;
    if (isChatSessionSwitch) {
      // de-select documents

      // reset all filters
      filterManager.setSelectedDocumentSets([]);
      filterManager.setSelectedSources([]);
      filterManager.setSelectedTags([]);
      filterManager.setTimeRange(null);

      // remove uploaded files
      setCurrentMessageFiles([]);

      // if switching from one chat to another, then need to scroll again
      // if we're creating a brand new chat, then don't need to scroll
      if (chatSessionIdRef.current !== null) {
        clearSelectedDocuments();
        setHasPerformedInitialScroll(false);
      }
    }

    async function initialSessionFetch() {
      if (existingChatSessionId === null) {
        setIsFetchingChatMessages(false);
        if (defaultAssistantId !== undefined) {
          setSelectedAssistantFromId(defaultAssistantId);
        } else {
          setSelectedAssistant(undefined);
        }
        updateCompleteMessageDetail(null, new Map());
        setChatSessionSharedStatus(ChatSessionSharedStatus.Private);

        // if we're supposed to submit on initial load, then do that here
        if (
          shouldSubmitOnLoad(searchParams) &&
          !submitOnLoadPerformed.current
        ) {
          submitOnLoadPerformed.current = true;
          await onSubmit();
        }
        return;
      }

      setIsFetchingChatMessages(true);
      const response = await fetch(
        `/api/chat/get-chat-session/${existingChatSessionId}`
      );

      const session = await response.json();
      const chatSession = session as BackendChatSession;
      setSelectedAssistantFromId(chatSession.persona_id);

      const newMessageMap = processRawChatHistory(chatSession.messages);
      const newMessageHistory = buildLatestMessageChain(newMessageMap);

      // Update message history except for edge where where
      // last message is an error and we're on a new chat.
      // This corresponds to a "renaming" of chat, which occurs after first message
      // stream
      if (
        (messageHistory[messageHistory.length - 1]?.type !== "error" ||
          loadedSessionId != null) &&
        !currentChatAnswering()
      ) {
        const latestMessageId =
          newMessageHistory[newMessageHistory.length - 1]?.messageId;

        setSelectedMessageForDocDisplay(
          latestMessageId !== undefined ? latestMessageId : null
        );

        updateCompleteMessageDetail(chatSession.chat_session_id, newMessageMap);
      }

      setChatSessionSharedStatus(chatSession.shared_status);

      // go to bottom. If initial load, then do a scroll,
      // otherwise just appear at the bottom

      scrollInitialized.current = false;

      if (!hasPerformedInitialScroll) {
        if (isInitialLoad.current) {
          setHasPerformedInitialScroll(true);
          isInitialLoad.current = false;
        }
        clientScrollToBottom();

        setTimeout(() => {
          setHasPerformedInitialScroll(true);
        }, 100);
      } else if (isChatSessionSwitch) {
        setHasPerformedInitialScroll(true);
        clientScrollToBottom(true);
      }

      setIsFetchingChatMessages(false);

      // if this is a seeded chat, then kick off the AI message generation
      if (
        newMessageHistory.length === 1 &&
        !submitOnLoadPerformed.current &&
        searchParams?.get(SEARCH_PARAM_NAMES.SEEDED) === "true"
      ) {
        submitOnLoadPerformed.current = true;
        const seededMessage = newMessageHistory[0].message;
        await onSubmit({
          isSeededChat: true,
          messageOverride: seededMessage,
        });
        // force re-name if the chat session doesn't have one
        if (!chatSession.description) {
          await nameChatSession(existingChatSessionId);
          refreshChatSessions();
        }
      } else if (newMessageHistory.length === 2 && !chatSession.description) {
        await nameChatSession(existingChatSessionId);
        refreshChatSessions();
      }
    }

    initialSessionFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingChatSessionId, searchParams?.get(SEARCH_PARAM_NAMES.PERSONA_ID)]);

  useEffect(() => {
    const userFolderId = searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID);
    const allMyDocuments = searchParams?.get(
      SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS
    );

    if (userFolderId) {
      const userFolder = userFolders.find(
        (folder) => folder.id === parseInt(userFolderId)
      );
      if (userFolder) {
        addSelectedFolder(userFolder);
      }
    } else if (allMyDocuments === "true" || allMyDocuments === "1") {
      // Clear any previously selected folders

      clearSelectedItems();

      // Add all user folders to the current context
      userFolders.forEach((folder) => {
        addSelectedFolder(folder);
      });
    }
  }, [
    userFolders,
    searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID),
    searchParams?.get(SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS),
    addSelectedFolder,
    clearSelectedItems,
  ]);

  const [message, setMessage] = useState(
    searchParams?.get(SEARCH_PARAM_NAMES.USER_PROMPT) || ""
  );

  const [completeMessageDetail, setCompleteMessageDetail] = useState<
    Map<string | null, Map<number, Message>>
  >(new Map());

  const updateCompleteMessageDetail = (
    sessionId: string | null,
    messageMap: Map<number, Message>
  ) => {
    setCompleteMessageDetail((prevState) => {
      const newState = new Map(prevState);
      newState.set(sessionId, messageMap);
      return newState;
    });
  };

  const currentMessageMap = (
    messageDetail: Map<string | null, Map<number, Message>>
  ) => {
    return (
      messageDetail.get(chatSessionIdRef.current) || new Map<number, Message>()
    );
  };
  const currentSessionId = (): string => {
    return chatSessionIdRef.current!;
  };

  const upsertToCompleteMessageMap = ({
    messages,
    completeMessageMapOverride,
    chatSessionId,
    replacementsMap = null,
    makeLatestChildMessage = false,
  }: {
    messages: Message[];
    // if calling this function repeatedly with short delay, stay may not update in time
    // and result in weird behavior
    completeMessageMapOverride?: Map<number, Message> | null;
    chatSessionId?: string;
    replacementsMap?: Map<number, number> | null;
    makeLatestChildMessage?: boolean;
  }) => {
    // deep copy
    const frozenCompleteMessageMap =
      completeMessageMapOverride || currentMessageMap(completeMessageDetail);
    const newCompleteMessageMap = structuredClone(frozenCompleteMessageMap);

    if (newCompleteMessageMap.size === 0) {
      const systemMessageId = messages[0].parentMessageId || SYSTEM_MESSAGE_ID;
      const firstMessageId = messages[0].messageId;
      const dummySystemMessage: Message = {
        messageId: systemMessageId,
        message: "",
        type: "system",
        files: [],
        toolCall: null,
        parentMessageId: null,
        childrenMessageIds: [firstMessageId],
        latestChildMessageId: firstMessageId,
      };
      newCompleteMessageMap.set(
        dummySystemMessage.messageId,
        dummySystemMessage
      );
      messages[0].parentMessageId = systemMessageId;
    }

    messages.forEach((message) => {
      const idToReplace = replacementsMap?.get(message.messageId);
      if (idToReplace) {
        removeMessage(idToReplace, newCompleteMessageMap);
      }

      // update childrenMessageIds for the parent
      if (
        !newCompleteMessageMap.has(message.messageId) &&
        message.parentMessageId !== null
      ) {
        updateParentChildren(message, newCompleteMessageMap, true);
      }
      newCompleteMessageMap.set(message.messageId, message);
    });
    // if specified, make these new message the latest of the current message chain
    if (makeLatestChildMessage) {
      const currentMessageChain = buildLatestMessageChain(
        frozenCompleteMessageMap
      );
      const latestMessage = currentMessageChain[currentMessageChain.length - 1];
      if (latestMessage) {
        newCompleteMessageMap.get(
          latestMessage.messageId
        )!.latestChildMessageId = messages[0].messageId;
      }
    }

    const newCompleteMessageDetail = {
      sessionId: chatSessionId || currentSessionId(),
      messageMap: newCompleteMessageMap,
    };

    updateCompleteMessageDetail(
      chatSessionId || currentSessionId(),
      newCompleteMessageMap
    );
    console.log(newCompleteMessageDetail);
    return newCompleteMessageDetail;
  };

  const messageHistory = buildLatestMessageChain(
    currentMessageMap(completeMessageDetail)
  );

  const [submittedMessage, setSubmittedMessage] = useState(firstMessage || "");

  const [chatState, setChatState] = useState<Map<string | null, ChatState>>(
    new Map([[chatSessionIdRef.current, firstMessage ? "loading" : "input"]])
  );

  const [regenerationState, setRegenerationState] = useState<
    Map<string | null, RegenerationState | null>
  >(new Map([[null, null]]));

  useEffect(() => {
    // Reset state when switching assistants
    updateChatState("input");
    resetRegenerationState(currentSessionId());
    setAlternativeGeneratingAssistant(null);
    setSubmittedMessage("");
    setAgenticGenerating(false);
    setSelectedMessageForDocDisplay(null);

    // Only reset GaugeMeter if the assistant is NOT Case Analysis
    if (liveAssistant?.name !== "Case Analysis") {
      setCaseAnalysisConfidence(null);
      setCaseAnalysisReasoning(null);
      setHasCaseAnalysisStarted(false);
    }

    clientScrollToBottom(true);
  }, [liveAssistant?.id]);

  const [abortControllers, setAbortControllers] = useState<
    Map<string | null, AbortController>
  >(new Map());

  // Updates "null" session values to new session id for
  // regeneration, chat, and abort controller state, messagehistory
  const updateStatesWithNewSessionId = (newSessionId: string) => {
    const updateState = (
      setState: Dispatch<SetStateAction<Map<string | null, any>>>,
      defaultValue?: any
    ) => {
      setState((prevState) => {
        const newState = new Map(prevState);
        const existingState = newState.get(null);
        if (existingState !== undefined) {
          newState.set(newSessionId, existingState);
          newState.delete(null);
        } else if (defaultValue !== undefined) {
          newState.set(newSessionId, defaultValue);
        }
        return newState;
      });
    };

    updateState(setRegenerationState);
    updateState(setChatState);
    updateState(setAbortControllers);

    // Update completeMessageDetail
    setCompleteMessageDetail((prevState) => {
      const newState = new Map(prevState);
      const existingMessages = newState.get(null);
      if (existingMessages) {
        newState.set(newSessionId, existingMessages);
        newState.delete(null);
      }
      return newState;
    });

    // Update chatSessionIdRef
    chatSessionIdRef.current = newSessionId;
  };

  const updateChatState = (newState: ChatState, sessionId?: string | null) => {
    setChatState((prevState) => {
      const newChatState = new Map(prevState);
      newChatState.set(
        sessionId !== undefined ? sessionId : currentSessionId(),
        newState
      );
      return newChatState;
    });
  };

  const currentChatState = (): ChatState => {
    return chatState.get(currentSessionId()) || "input";
  };

  const currentChatAnswering = () => {
    return (
      currentChatState() == "toolBuilding" ||
      currentChatState() == "streaming" ||
      currentChatState() == "loading"
    );
  };

  const updateRegenerationState = (
    newState: RegenerationState | null,
    sessionId?: string | null
  ) => {
    const newRegenerationState = new Map(regenerationState);
    newRegenerationState.set(
      sessionId !== undefined && sessionId != null
        ? sessionId
        : currentSessionId(),
      newState
    );

    setRegenerationState((prevState) => {
      const newRegenerationState = new Map(prevState);
      newRegenerationState.set(
        sessionId !== undefined && sessionId != null
          ? sessionId
          : currentSessionId(),
        newState
      );
      return newRegenerationState;
    });
  };

  const resetRegenerationState = (sessionId?: string | null) => {
    updateRegenerationState(null, sessionId);
  };

  const currentRegenerationState = (): RegenerationState | null => {
    return regenerationState.get(currentSessionId()) || null;
  };

  const [canContinue, setCanContinue] = useState<Map<string | null, boolean>>(
    new Map([[null, false]])
  );

  const updateCanContinue = (newState: boolean, sessionId?: string | null) => {
    setCanContinue((prevState) => {
      const newCanContinueState = new Map(prevState);
      newCanContinueState.set(
        sessionId !== undefined ? sessionId : currentSessionId(),
        newState
      );
      return newCanContinueState;
    });
  };

  const currentCanContinue = (): boolean => {
    return canContinue.get(currentSessionId()) || false;
  };

  const currentSessionChatState = currentChatState();
  const currentSessionRegenerationState = currentRegenerationState();

  // for document display
  // NOTE: -1 is a special designation that means the latest AI message
  const [selectedMessageForDocDisplay, setSelectedMessageForDocDisplay] =
    useState<number | null>(null);

  const { aiMessage, humanMessage } = selectedMessageForDocDisplay
    ? getHumanAndAIMessageFromMessageNumber(
      messageHistory,
      selectedMessageForDocDisplay
    )
    : { aiMessage: null, humanMessage: null };

  const [chatSessionSharedStatus, setChatSessionSharedStatus] =
    useState<ChatSessionSharedStatus>(ChatSessionSharedStatus.Private);

  useEffect(() => {
    if (messageHistory.length === 0 && chatSessionIdRef.current === null) {
      // Select from available assistants so shared assistants appear.
      setSelectedAssistant(
        availableAssistants.find((persona) => persona.id === defaultAssistantId)
      );
    }
  }, [defaultAssistantId, availableAssistants, messageHistory.length]);

  useEffect(() => {
    if (
      submittedMessage &&
      currentSessionChatState === "loading" &&
      messageHistory.length == 0
    ) {
      window.parent.postMessage(
        { type: CHROME_MESSAGE.LOAD_NEW_CHAT_PAGE },
        "*"
      );
    }
  }, [submittedMessage, currentSessionChatState]);
  // just choose a conservative default, this will be updated in the
  // background on initial load / on persona change
  const [maxTokens, setMaxTokens] = useState<number>(4096);

  // fetch # of allowed document tokens for the selected Persona
  useEffect(() => {
    async function fetchMaxTokens() {
      const response = await fetch(
        `/api/chat/max-selected-document-tokens?persona_id=${liveAssistant?.id}`
      );
      if (response.ok) {
        const maxTokens = (await response.json()).max_tokens as number;
        setMaxTokens(maxTokens);
      }
    }
    fetchMaxTokens();
  }, [liveAssistant]);

  const filterManager = useFilters();
  const [isChatSearchModalOpen, setIsChatSearchModalOpen] = useState(false);

  const [currentFeedback, setCurrentFeedback] = useState<
    [FeedbackType, number] | null
  >(null);

  const [sharingModalVisible, setSharingModalVisible] =
    useState<boolean>(false);

  const [aboveHorizon, setAboveHorizon] = useState(false);

  const scrollableDivRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const endDivRef = useRef<HTMLDivElement>(null);
  const endPaddingRef = useRef<HTMLDivElement>(null);

  const previousHeight = useRef<number>(
    inputRef.current?.getBoundingClientRect().height!
  );
  const scrollDist = useRef<number>(0);

  const handleInputResize = () => {
    setTimeout(() => {
      if (
        inputRef.current &&
        lastMessageRef.current &&
        !waitForScrollRef.current
      ) {
        const newHeight: number =
          inputRef.current?.getBoundingClientRect().height!;
        const heightDifference = newHeight - previousHeight.current;
        if (
          previousHeight.current &&
          heightDifference != 0 &&
          endPaddingRef.current &&
          scrollableDivRef &&
          scrollableDivRef.current
        ) {
          endPaddingRef.current.style.transition = "height 0.3s ease-out";
          endPaddingRef.current.style.height = `${Math.max(
            newHeight - 50,
            0
          )}px`;

          if (autoScrollEnabled) {
            scrollableDivRef?.current.scrollBy({
              left: 0,
              top: Math.max(heightDifference, 0),
              behavior: "smooth",
            });
          }
        }
        previousHeight.current = newHeight;
      }
    }, 100);
  };

  const clientScrollToBottom = (fast?: boolean) => {
    waitForScrollRef.current = true;

    setTimeout(() => {
      if (!endDivRef.current || !scrollableDivRef.current) {
        console.error("endDivRef or scrollableDivRef not found");
        return;
      }

      const rect = endDivRef.current.getBoundingClientRect();
      const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

      if (isVisible) return;

      // Check if all messages are currently rendered
      // If all messages are already rendered, scroll immediately
      endDivRef.current.scrollIntoView({
        behavior: fast ? "auto" : "smooth",
      });

      setHasPerformedInitialScroll(true);
    }, 50);

    // Reset waitForScrollRef after 1.5 seconds
    setTimeout(() => {
      waitForScrollRef.current = false;
    }, 1500);
  };

  const debounceNumber = 100; // time for debouncing

  const [hasPerformedInitialScroll, setHasPerformedInitialScroll] = useState(
    existingChatSessionId === null
  );

  // handle re-sizing of the text area
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    handleInputResize();
  }, [message]);

  // used for resizing of the document sidebar
  const masterFlexboxRef = useRef<HTMLDivElement>(null);
  const [maxDocumentSidebarWidth, setMaxDocumentSidebarWidth] = useState<
    number | null
  >(null);
  const adjustDocumentSidebarWidth = () => {
    if (masterFlexboxRef.current && document.documentElement.clientWidth) {
      // numbers below are based on the actual width the center section for different
      // screen sizes. `1700` corresponds to the custom "3xl" tailwind breakpoint
      // NOTE: some buffer is needed to account for scroll bars
      if (document.documentElement.clientWidth > 1700) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 950);
      } else if (document.documentElement.clientWidth > 1420) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 760);
      } else {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 660);
      }
    }
  };

  useEffect(() => {
    if (
      (!personaIncludesRetrieval &&
        (!selectedDocuments || selectedDocuments.length === 0) &&
        documentSidebarVisible) ||
      chatSessionIdRef.current == undefined
    ) {
      setDocumentSidebarVisible(false);
    }
    clientScrollToBottom();
  }, [chatSessionIdRef.current]);

  const loadNewPageLogic = (event: MessageEvent) => {
    if (event.data.type === SUBMIT_MESSAGE_TYPES.PAGE_CHANGE) {
      try {
        const url = new URL(event.data.href);
        processSearchParamsAndSubmitMessage(url.searchParams.toString());
      } catch (error) {
        console.error("Error parsing URL:", error);
      }
    }
  };

  // Equivalent to `loadNewPageLogic`
  useEffect(() => {
    if (searchParams?.get(SEARCH_PARAM_NAMES.SEND_ON_LOAD)) {
      processSearchParamsAndSubmitMessage(searchParams.toString());
    }
  }, [searchParams, router]);

  useEffect(() => {
    adjustDocumentSidebarWidth();
    window.addEventListener("resize", adjustDocumentSidebarWidth);
    window.addEventListener("message", loadNewPageLogic);

    return () => {
      window.removeEventListener("message", loadNewPageLogic);
      window.removeEventListener("resize", adjustDocumentSidebarWidth);
    };
  }, []);

  if (!documentSidebarInitialWidth && maxDocumentSidebarWidth) {
    documentSidebarInitialWidth = Math.min(700, maxDocumentSidebarWidth);
  }
  class CurrentMessageFIFO {
    private stack: PacketType[] = [];
    isComplete: boolean = false;
    error: string | null = null;

    push(packetBunch: PacketType) {
      this.stack.push(packetBunch);
    }

    nextPacket(): PacketType | undefined {
      return this.stack.shift();
    }

    isEmpty(): boolean {
      return this.stack.length === 0;
    }
  }

  async function updateCurrentMessageFIFO(
    stack: CurrentMessageFIFO,
    params: SendMessageParams
  ) {
    try {
      for await (const packet of sendMessage(params)) {
        if (params.signal?.aborted) {
          throw new Error("AbortError");
        }
        stack.push(packet);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          console.debug("Stream aborted");
        } else {
          stack.error = error.message;
        }
      } else {
        stack.error = String(error);
      }
    } finally {
      stack.isComplete = true;
    }
  }

  const resetInputBar = () => {
    setMessage("");
    setCurrentMessageFiles([]);
    if (endPaddingRef.current) {
      endPaddingRef.current.style.height = `95px`;
    }
  };

  const continueGenerating = () => {
    onSubmit({
      messageOverride:
        "Continue Generating (pick up exactly where you left off)",
    });
  };
  const [uncaughtError, setUncaughtError] = useState<string | null>(null);
  const [agenticGenerating, setAgenticGenerating] = useState(false);

  const autoScrollEnabled =
    (user?.preferences?.auto_scroll && !agenticGenerating) ?? false;

  useScrollonStream({
    chatState: currentSessionChatState,
    scrollableDivRef,
    scrollDist,
    endDivRef,
    debounceNumber,
    mobile: settings?.isMobile,
    enableAutoScroll: autoScrollEnabled,
  });

  // Track whether a message has been sent during this page load, keyed by chat session id
  const [sessionHasSentLocalUserMessage, setSessionHasSentLocalUserMessage] =
    useState<Map<string | null, boolean>>(new Map());

  // Update the local state for a session once the user sends a message
  const markSessionMessageSent = (sessionId: string | null) => {
    setSessionHasSentLocalUserMessage((prev) => {
      const newMap = new Map(prev);
      newMap.set(sessionId, true);
      return newMap;
    });
  };
  const currentSessionHasSentLocalUserMessage = useMemo(
    () => (sessionId: string | null) => {
      return sessionHasSentLocalUserMessage.size === 0
        ? undefined
        : sessionHasSentLocalUserMessage.get(sessionId) || false;
    },
    [sessionHasSentLocalUserMessage]
  );

  const { height: screenHeight } = useScreenSize();

  const getContainerHeight = useMemo(() => {
    return () => {
      if (!currentSessionHasSentLocalUserMessage(chatSessionIdRef.current)) {
        return undefined;
      }
      if (autoScrollEnabled) return undefined;

      if (screenHeight < 600) return "40vh";
      if (screenHeight < 1200) return "50vh";
      return "60vh";
    };
  }, [autoScrollEnabled, screenHeight, currentSessionHasSentLocalUserMessage]);

  const reset = () => {
    setMessage("");
    setCurrentMessageFiles([]);
    clearSelectedItems();
    setLoadingError(null);
  };

  const onSubmit = async ({
    messageIdToResend,
    messageOverride,
    queryOverride,
    forceSearch,
    isSeededChat,
    alternativeAssistantOverride = null,
    modelOverride,
    regenerationRequest,
    overrideFileDescriptors,
  }: {
    messageIdToResend?: number;
    messageOverride?: string;
    queryOverride?: string;
    forceSearch?: boolean;
    isSeededChat?: boolean;
    alternativeAssistantOverride?: Persona | null;
    modelOverride?: LlmDescriptor;
    regenerationRequest?: RegenerationRequest | null;
    overrideFileDescriptors?: FileDescriptor[];
  } = {}) => {
    navigatingAway.current = false;
    let frozenSessionId = currentSessionId();
    updateCanContinue(false, frozenSessionId);
    setUncaughtError(null);
    setLoadingError(null);

    // Mark that we've sent a message for this session in the current page load
    markSessionMessageSent(frozenSessionId);

    // Check if the last message was an error and remove it before proceeding with a new message
    // Ensure this isn't a regeneration or resend, as those operations should preserve the history leading up to the point of regeneration/resend.
    let currentMap = currentMessageMap(completeMessageDetail);
    let currentHistory = buildLatestMessageChain(currentMap);
    let lastMessage = currentHistory[currentHistory.length - 1];

    if (
      lastMessage &&
      lastMessage.type === "error" &&
      !messageIdToResend &&
      !regenerationRequest
    ) {
      const newMap = new Map(currentMap);
      const parentId = lastMessage.parentMessageId;

      // Remove the error message itself
      newMap.delete(lastMessage.messageId);

      // Remove the parent message + update the parent of the parent to no longer
      // link to the parent
      if (parentId !== null && parentId !== undefined) {
        const parentOfError = newMap.get(parentId);
        if (parentOfError) {
          const grandparentId = parentOfError.parentMessageId;
          if (grandparentId !== null && grandparentId !== undefined) {
            const grandparent = newMap.get(grandparentId);
            if (grandparent) {
              // Update grandparent to no longer link to parent
              const updatedGrandparent = {
                ...grandparent,
                childrenMessageIds: (
                  grandparent.childrenMessageIds || []
                ).filter((id) => id !== parentId),
                latestChildMessageId:
                  grandparent.latestChildMessageId === parentId
                    ? null
                    : grandparent.latestChildMessageId,
              };
              newMap.set(grandparentId, updatedGrandparent);
            }
          }
          // Remove the parent message
          newMap.delete(parentId);
        }
      }
      // Update the state immediately so subsequent logic uses the cleaned map
      updateCompleteMessageDetail(frozenSessionId, newMap);
      console.log("Removed previous error message ID:", lastMessage.messageId);

      // update state for the new world (with the error message removed)
      currentHistory = buildLatestMessageChain(newMap);
      currentMap = newMap;
      lastMessage = currentHistory[currentHistory.length - 1];
    }

    if (currentChatState() != "input") {
      if (currentChatState() == "uploading") {
        setPopup({
          message: "Please wait for the content to upload",
          type: "error",
        });
      } else {
        setPopup({
          message: "Please wait for the response to complete",
          type: "error",
        });
      }

      return;
    }

    setAlternativeGeneratingAssistant(alternativeAssistantOverride);

    clientScrollToBottom();

    let currChatSessionId: string;
    const isNewSession = chatSessionIdRef.current === null;

    const searchParamBasedChatSessionName =
      searchParams?.get(SEARCH_PARAM_NAMES.TITLE) || null;

    if (isNewSession) {
      currChatSessionId = await createChatSession(
        liveAssistant?.id || 0,
        searchParamBasedChatSessionName
      );
    } else {
      currChatSessionId = chatSessionIdRef.current as string;
    }
    frozenSessionId = currChatSessionId;
    // update the selected model for the chat session if one is specified so that
    // it persists across page reloads. Do not `await` here so that the message
    // request can continue and this will just happen in the background.
    // NOTE: only set the model override for the chat session once we send a
    // message with it. If the user switches models and then starts a new
    // chat session, it is unexpected for that model to be used when they
    // return to this session the next day.
    let finalLLM = modelOverride || llmManager.currentLlm;
    updateLlmOverrideForChatSession(
      currChatSessionId,
      structureValue(
        finalLLM.name || "",
        finalLLM.provider || "",
        finalLLM.modelName || ""
      )
    );

    updateStatesWithNewSessionId(currChatSessionId);

    const controller = new AbortController();

    setAbortControllers((prev) =>
      new Map(prev).set(currChatSessionId, controller)
    );

    const messageToResend = messageHistory.find(
      (message) => message.messageId === messageIdToResend
    );
    if (messageIdToResend) {
      updateRegenerationState(
        { regenerating: true, finalMessageIndex: messageIdToResend },
        currentSessionId()
      );
    }
    const messageToResendParent =
      messageToResend?.parentMessageId !== null &&
        messageToResend?.parentMessageId !== undefined
        ? currentMap.get(messageToResend.parentMessageId)
        : null;
    const messageToResendIndex = messageToResend
      ? messageHistory.indexOf(messageToResend)
      : null;

    if (!messageToResend && messageIdToResend !== undefined) {
      setPopup({
        message:
          "Failed to re-send message - please refresh the page and try again.",
        type: "error",
      });
      resetRegenerationState(currentSessionId());
      updateChatState("input", frozenSessionId);
      return;
    }
    let currMessage = messageToResend ? messageToResend.message : message;
    if (messageOverride) {
      currMessage = messageOverride;
    }

    setSubmittedMessage(currMessage);

    updateChatState("loading");

    const currMessageHistory =
      messageToResendIndex !== null
        ? currentHistory.slice(0, messageToResendIndex)
        : currentHistory;

    let parentMessage =
      messageToResendParent ||
      (currMessageHistory.length > 0
        ? currMessageHistory[currMessageHistory.length - 1]
        : null) ||
      (currentMap.size === 1 ? Array.from(currentMap.values())[0] : null);

    let currentAssistantId;
    if (alternativeAssistantOverride) {
      currentAssistantId = alternativeAssistantOverride.id;
    } else if (alternativeAssistant) {
      currentAssistantId = alternativeAssistant.id;
    } else {
      currentAssistantId = liveAssistant.id;
    }

    resetInputBar();
    let messageUpdates: Message[] | null = null;

    let answer = "";
    let second_level_answer = "";

    const stopReason: StreamStopReason | null = null;
    let query: string | null = null;
    let retrievalType: RetrievalType =
      selectedDocuments.length > 0
        ? RetrievalType.SelectedDocs
        : RetrievalType.None;
    let documents: OnyxDocument[] = selectedDocuments;
    let aiMessageImages: FileDescriptor[] | null = null;
    let agenticDocs: OnyxDocument[] | null = null;
    let error: string | null = null;
    let stackTrace: string | null = null;

    let sub_questions: SubQuestionDetail[] = [];
    let is_generating: boolean = false;
    let second_level_generating: boolean = false;
    let finalMessage: BackendMessage | null = null;
    let toolCall: ToolCallMetadata | null = null;
    let isImprovement: boolean | undefined = undefined;
    let isStreamingQuestions = true;
    let includeAgentic = false;
    let secondLevelMessageId: number | null = null;
    let isAgentic: boolean = false;
    let files: FileDescriptor[] = [];

    let initialFetchDetails: null | {
      user_message_id: number;
      assistant_message_id: number;
      frozenMessageMap: Map<number, Message>;
    } = null;
    try {
      const mapKeys = Array.from(currentMap.keys());
      const lastSuccessfulMessageId =
        getLastSuccessfulMessageId(currMessageHistory);

      // Route to /api/caseprediction if assistant is Case Analysis
      const isCaseAnalysis = liveAssistant?.name === "Case Analysis";
      setCaseAnalysisConfidence(null);
      setCaseAnalysisReasoning(null);
      if (isCaseAnalysis) {
        setCaseAnalysisConfidence(null);
        setCaseAnalysisReasoning(null);

        try {
          const response = await fetch("/api/caseprediction/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: currMessage }),
          });

          if (!response.ok) throw new Error("Case analysis failed");

          const result = await response.json(); // { prediction, confidence, reasoning }

          const newMessageId = Date.now();

          const userMessage: Message = {
            messageId: newMessageId - 1,
            message: currMessage,
            type: "user",
            files: [],
            toolCall: null,
            parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
          };

          const predictionLabel =
            result.prediction === 1
              ? "Accepted"
              : result.prediction === 0
                ? "Rejected"
                : result.prediction; // fallback in case it's unexpected

          const confidencePercent = `${result.confidence}%`;

          const assistantMessage: Message = {
            messageId: newMessageId,
            message: `**Prediction:** ${predictionLabel}\n\n**Confidence:** ${confidencePercent}\n\n**Reasoning:** ${result.reasoning}`,
            type: "assistant",
            files: [],
            toolCall: null,
            parentMessageId: userMessage.messageId,
          };

          // Save result for GaugeMeter
          const confidenceValue = parseFloat(result.confidence);
          setCaseAnalysisConfidence(isNaN(confidenceValue) ? null : confidenceValue);
          setCaseAnalysisReasoning(result.reasoning || null);
          setHasCaseAnalysisStarted(true);

          // Add to message map
          upsertToCompleteMessageMap({
            messages: [userMessage, assistantMessage],
            chatSessionId: currChatSessionId,
          });

          try {
            await setMessageAsLatest(assistantMessage.messageId);
          } catch (err) {
            console.error("Failed to set message as latest:", err);
          }

          updateChatState("input");
          resetRegenerationState();
          return;
        } catch (error) {
          console.error("Case Analysis Error:", error);
          updateChatState("input");
          setPopup({
            type: "error",
            message: "Case analysis failed to respond.",
          });
          return;
        }
      }

      // Route to /api/deepsearch/submit if assistant is Deep Search
      const isDeepSearch = liveAssistant?.name === "Deep Search";
      if (isDeepSearch) {
        try {
          // Step 1: Submit deepsearch job
          const submitResponse = await fetch("/api/deepsearch/submit", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: currMessage }),
          });

          if (!submitResponse.ok) throw new Error("Failed to submit Deep Search job");

          const { job_id } = await submitResponse.json();

          // Step 2: Poll for result
          let attempts = 0;
          let result = null;
          const maxAttempts = 100;
          const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

          while (attempts < maxAttempts) {
            const statusResponse = await fetch(`/api/deepsearch/status/${job_id}`);
            if (!statusResponse.ok) throw new Error("Failed to get job status");

            const statusData = await statusResponse.json();
            if (statusData.status === "completed") {
              result = statusData.result;
              break;
            } else if (statusData.status === "error") {
              throw new Error(statusData.error || "Deep Search failed");
            }

            await delay(3000); // wait 3s before next poll
            attempts++;
          }

          if (!result) throw new Error("Deep Search timed out");

          const newMessageId = Date.now();

          const userMessage: Message = {
            messageId: newMessageId - 1,
            message: currMessage,
            type: "user",
            files: [],
            toolCall: null,
            parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
          };

          const assistantMessage: Message = {
            messageId: newMessageId,
            message: result.article || result.outline || "No article, outline or citations was returned from Deep Search.",
            type: "assistant",
            citations: result.citations || {},
            files: [],
            toolCall: null,
            parentMessageId: userMessage.messageId,
          };

          upsertToCompleteMessageMap({
            messages: [userMessage, assistantMessage],
            chatSessionId: currChatSessionId,
          });

          await setMessageAsLatest(assistantMessage.messageId);
          updateChatState("input");
          resetRegenerationState();
          return;
        } catch (err) {
          console.error("Deep Search Error:", err);
          updateChatState("input");
          setPopup({
            type: "error",
            message: "Deep Search failed to respond.",
          });
          return;
        }
      }

      // Route to /api/legacysearch/judgements/search if assistant is Legacy Search
      const isLegacySearch = liveAssistant?.name === "Legacy Search";
      if (isLegacySearch && searchDomain === 'judgements') {
        try {
          const PAGE_SIZE = 20;
          const baseParams: QueryParams = {
            query: currMessage,
            courts: selectedCourts,
            judge_name: null,
            case_title: null,
            start_date: null,
            end_date: null,
            page_size: PAGE_SIZE,
            keywords: [], // no refine for the simple path
          };

          const response = await fetch("/api/legacysearch/judgements/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...baseParams,
              page: 1,
            }),
          });

          if (!response.ok) throw new Error("Legacy Search failed");

          const result = await response.json(); // { results, total, sc_total, hc_total, page, page_size, has_more }
          const queryId = Date.now().toString();

          // Keep results in history
          setSearchHistory(prev => [
            ...prev,
            {
              id: queryId,
              query: currMessage,
              results: result.results,
              meta: {
                sc_total: result.sc_total,
                hc_total: result.hc_total,
                total: result.total,
                page: 1,
                page_size: PAGE_SIZE,
                has_more: result.has_more,
              },
            },
          ]);
          setSelectedQueryId(queryId);
          setRefineSnippetsByIndex({}); // reset refine state on fresh search

          // Register pager for "Show more"
          setPager(prev => ({
            ...prev,
            [queryId]: {
              domain: 'judgements',
              currentPage: 1,
              totalPages: Math.max(1, Math.ceil((result.total ?? 0) / PAGE_SIZE)),
              total: result.total ?? undefined,
              pageSize: PAGE_SIZE,
              hasMore: !!result.has_more,
              params: baseParams,
              cache: { 1: Array.isArray(result.results) ? [...result.results] : [] },
            },
          }));

          const newMessageId = Date.now();

          const userMessage: Message = {
            messageId: newMessageId - 1,
            message: currMessage,
            type: "user",
            files: [],
            toolCall: null,
            parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
          };

          // First page only: optionally inject empty blocks for SC/HC totals == 0
          let displayResults = [...result.results];
          if (bothCourtsSelected(selectedCourts)) {
            const hasSC = displayResults.some((r) => r.source === "SC");
            const hasHC = displayResults.some((r) => r.source === "HC");
            const scTotal = result.sc_total ?? 0;
            const hcTotal = result.hc_total ?? 0;
            if (!hasSC && scTotal === 0) displayResults.unshift(buildEmptySCRow());
            if (!hasHC && hcTotal === 0) displayResults.push(buildEmptyHCRow(highCourtsFrom(selectedCourts)));
          }

          const header = headerLine(0, result.results.length, result.total, result.sc_total, result.hc_total);
          const body = renderRowsChunk(displayResults, 0);

          const assistantMessage: Message = {
            messageId: newMessageId,
            message: `${header}\n\n${body}`,
            type: "assistant",
            files: [],
            toolCall: null,
            parentMessageId: userMessage.messageId,
          };

          upsertToCompleteMessageMap({
            messages: [userMessage, assistantMessage],
            chatSessionId: currChatSessionId,
          });

          await setMessageAsLatest(assistantMessage.messageId);
          updateChatState("input");
          resetRegenerationState();
          return;
        } catch (error) {
          console.error("Legacy Search Error:", error);
          updateChatState("input");
          setPopup({ type: "error", message: "Legacy Search failed to respond." });
          return;
        }
      } else if (isLegacySearch && searchDomain === 'statutes') {
        try {
          const PAGE_SIZE = 20;
          const baseParams: StatutesQueryParams = {
            query: currMessage,
            statutes: [...selectedStatutes],
            section_title: null,
            page_size: PAGE_SIZE,
            keywords: [],
          };

          const result = await fetchStatutesPage(baseParams, 1, /*useAdvanced*/ false);
          const queryId = Date.now().toString();

          // store history
          setSearchHistory(prev => [
            ...prev,
            {
              id: queryId,
              query: currMessage,
              results: result.results,
              meta: {
                central_total: result.central_total,
                state_total: result.state_total,
                total: result.total,
                page: 1,
                page_size: PAGE_SIZE,
                has_more: result.has_more,
              },
            },
          ]);
          setSelectedQueryId(queryId);
          setRefineSnippetsByIndex({});

          // register pager for Show More (statutes uses load-more UX)
          setPager(prev => ({
            ...prev,
            [queryId]: {
              domain: 'statutes',
              currentPage: 1,
              totalPages: Math.max(1, Math.ceil((result.total ?? 0) / PAGE_SIZE)),
              total: result.total ?? undefined,
              pageSize: PAGE_SIZE,
              hasMore: !!result.has_more,
              params: baseParams, // StatutesQueryParams
              cache: { 1: Array.isArray(result.results) ? [...result.results] : [] },
            },
          }));

          const newMessageId = Date.now();

          const userMessage: Message = {
            messageId: newMessageId - 1,
            message: currMessage,
            type: "user",
            files: [],
            toolCall: null,
            parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
          };

          const header = headerLineStatutes(
            0,
            result.results.length,
            result.total,
            result.central_total,
            result.state_total
          );
          const body = renderRowsChunkStatutes(result.results, 0);

          const assistantMessage: Message = {
            messageId: newMessageId,
            message: `${header}\n\n${body}`,
            type: "assistant",
            files: [],
            toolCall: null,
            parentMessageId: userMessage.messageId,
          };

          upsertToCompleteMessageMap({
            messages: [userMessage, assistantMessage],
            chatSessionId: currChatSessionId,
          });

          await setMessageAsLatest(assistantMessage.messageId);
          updateChatState("input");
          resetRegenerationState();
          return;
        } catch (error) {
          console.error("Legacy Search (statutes) Error:", error);
          updateChatState("input");
          setPopup({ type: "error", message: "Legacy Search (statutes) failed to respond." });
          return;
        }
      }

      const stack = new CurrentMessageFIFO();

      updateCurrentMessageFIFO(stack, {
        signal: controller.signal,
        message: currMessage,
        alternateAssistantId: currentAssistantId,
        fileDescriptors: overrideFileDescriptors || currentMessageFiles,
        parentMessageId:
          regenerationRequest?.parentMessage.messageId ||
          lastSuccessfulMessageId,
        chatSessionId: currChatSessionId,
        filters: buildFilters(
          filterManager.selectedSources,
          filterManager.selectedDocumentSets,
          filterManager.timeRange,
          filterManager.selectedTags,
          selectedFiles.map((file) => file.id),
          selectedFolders.map((folder) => folder.id)
        ),
        selectedDocumentIds: selectedDocuments
          .filter(
            (document) =>
              document.db_doc_id !== undefined && document.db_doc_id !== null
          )
          .map((document) => document.db_doc_id as number),
        queryOverride,
        forceSearch,
        userFolderIds: selectedFolders.map((folder) => folder.id),
        userFileIds: selectedFiles
          .filter((file) => file.id !== undefined && file.id !== null)
          .map((file) => file.id),

        regenerate: regenerationRequest !== undefined,
        modelProvider:
          modelOverride?.name || llmManager.currentLlm.name || undefined,
        modelVersion:
          modelOverride?.modelName ||
          llmManager.currentLlm.modelName ||
          searchParams?.get(SEARCH_PARAM_NAMES.MODEL_VERSION) ||
          undefined,
        temperature: llmManager.temperature || undefined,
        systemPromptOverride:
          searchParams?.get(SEARCH_PARAM_NAMES.SYSTEM_PROMPT) || undefined,
        useExistingUserMessage: isSeededChat,
        useLanggraph:
          settings?.settings.pro_search_enabled &&
          proSearchEnabled &&
          retrievalEnabled,
      });

      const delay = (ms: number) => {
        return new Promise((resolve) => setTimeout(resolve, ms));
      };

      await delay(50);
      while (!stack.isComplete || !stack.isEmpty()) {
        if (stack.isEmpty()) {
          await delay(0.5);
        }

        if (!stack.isEmpty() && !controller.signal.aborted) {
          const packet = stack.nextPacket();
          if (!packet) {
            continue;
          }
          console.log("Packet:", JSON.stringify(packet));

          if (!initialFetchDetails) {
            if (!Object.hasOwn(packet, "user_message_id")) {
              console.error(
                "First packet should contain message response info "
              );
              if (Object.hasOwn(packet, "error")) {
                const error = (packet as StreamingError).error;
                setLoadingError(error);
                updateChatState("input");
                return;
              }
              continue;
            }

            const messageResponseIDInfo = packet as MessageResponseIDInfo;

            const user_message_id = messageResponseIDInfo.user_message_id!;
            const assistant_message_id =
              messageResponseIDInfo.reserved_assistant_message_id;

            // we will use tempMessages until the regenerated message is complete
            messageUpdates = [
              {
                messageId: regenerationRequest
                  ? regenerationRequest?.parentMessage?.messageId!
                  : user_message_id,
                message: currMessage,
                type: "user",
                files: files,
                toolCall: null,
                parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
              },
            ];

            if (parentMessage && !regenerationRequest) {
              messageUpdates.push({
                ...parentMessage,
                childrenMessageIds: (
                  parentMessage.childrenMessageIds || []
                ).concat([user_message_id]),
                latestChildMessageId: user_message_id,
              });
            }

            const { messageMap: currentFrozenMessageMap } =
              upsertToCompleteMessageMap({
                messages: messageUpdates,
                chatSessionId: currChatSessionId,
                completeMessageMapOverride: currentMap,
              });
            currentMap = currentFrozenMessageMap;

            initialFetchDetails = {
              frozenMessageMap: currentMap,
              assistant_message_id,
              user_message_id,
            };

            resetRegenerationState();
          } else {
            const { user_message_id, frozenMessageMap } = initialFetchDetails;
            if (Object.hasOwn(packet, "agentic_message_ids")) {
              const agenticMessageIds = (packet as AgenticMessageResponseIDInfo)
                .agentic_message_ids;
              const level1MessageId = agenticMessageIds.find(
                (item) => item.level === 1
              )?.message_id;
              if (level1MessageId) {
                secondLevelMessageId = level1MessageId;
                includeAgentic = true;
              }
            }

            setChatState((prevState) => {
              if (prevState.get(chatSessionIdRef.current!) === "loading") {
                return new Map(prevState).set(
                  chatSessionIdRef.current!,
                  "streaming"
                );
              }
              return prevState;
            });

            if (Object.hasOwn(packet, "level")) {
              if ((packet as any).level === 1) {
                second_level_generating = true;
              }
            }
            if (Object.hasOwn(packet, "user_files")) {
              const userFiles = (packet as UserKnowledgeFilePacket).user_files;
              // Ensure files are unique by id
              const newUserFiles = userFiles.filter(
                (newFile) =>
                  !files.some((existingFile) => existingFile.id === newFile.id)
              );
              files = files.concat(newUserFiles);
            }
            if (Object.hasOwn(packet, "is_agentic")) {
              isAgentic = (packet as any).is_agentic;
            }

            if (Object.hasOwn(packet, "refined_answer_improvement")) {
              isImprovement = (packet as RefinedAnswerImprovement)
                .refined_answer_improvement;
            }

            if (Object.hasOwn(packet, "stream_type")) {
              if ((packet as any).stream_type == "main_answer") {
                is_generating = false;
                second_level_generating = true;
              }
            }

            // // Continuously refine the sub_questions based on the packets that we receive
            if (
              Object.hasOwn(packet, "stop_reason") &&
              Object.hasOwn(packet, "level_question_num")
            ) {
              if ((packet as StreamStopInfo).stream_type == "main_answer") {
                updateChatState("streaming", frozenSessionId);
              }
              if (
                (packet as StreamStopInfo).stream_type == "sub_questions" &&
                (packet as StreamStopInfo).level_question_num == undefined
              ) {
                isStreamingQuestions = false;
              }
              sub_questions = constructSubQuestions(
                sub_questions,
                packet as StreamStopInfo
              );
            } else if (Object.hasOwn(packet, "sub_question")) {
              updateChatState("toolBuilding", frozenSessionId);
              isAgentic = true;
              is_generating = true;
              sub_questions = constructSubQuestions(
                sub_questions,
                packet as SubQuestionPiece
              );
              setAgenticGenerating(true);
            } else if (Object.hasOwn(packet, "sub_query")) {
              sub_questions = constructSubQuestions(
                sub_questions,
                packet as SubQueryPiece
              );
            } else if (
              Object.hasOwn(packet, "answer_piece") &&
              Object.hasOwn(packet, "answer_type") &&
              (packet as AgentAnswerPiece).answer_type === "agent_sub_answer"
            ) {
              sub_questions = constructSubQuestions(
                sub_questions,
                packet as AgentAnswerPiece
              );
            } else if (Object.hasOwn(packet, "answer_piece")) {
              // Mark every sub_question's is_generating as false
              sub_questions = sub_questions.map((subQ) => ({
                ...subQ,
                is_generating: false,
              }));

              if (
                Object.hasOwn(packet, "level") &&
                (packet as any).level === 1
              ) {
                second_level_answer += (packet as AnswerPiecePacket)
                  .answer_piece;
              } else {
                answer += (packet as AnswerPiecePacket).answer_piece;
              }
            } else if (
              Object.hasOwn(packet, "top_documents") &&
              Object.hasOwn(packet, "level_question_num") &&
              (packet as DocumentsResponse).level_question_num != undefined
            ) {
              const documentsResponse = packet as DocumentsResponse;
              sub_questions = constructSubQuestions(
                sub_questions,
                documentsResponse
              );

              if (
                documentsResponse.level_question_num === 0 &&
                documentsResponse.level == 0
              ) {
                documents = (packet as DocumentsResponse).top_documents;
              } else if (
                documentsResponse.level_question_num === 0 &&
                documentsResponse.level == 1
              ) {
                agenticDocs = (packet as DocumentsResponse).top_documents;
              }
            } else if (Object.hasOwn(packet, "top_documents")) {
              documents = (packet as DocumentInfoPacket).top_documents;
              retrievalType = RetrievalType.Search;

              if (documents && documents.length > 0) {
                // point to the latest message (we don't know the messageId yet, which is why
                // we have to use -1)
                setSelectedMessageForDocDisplay(user_message_id);
              }
            } else if (Object.hasOwn(packet, "tool_name")) {
              // Will only ever be one tool call per message
              toolCall = {
                tool_name: (packet as ToolCallMetadata).tool_name,
                tool_args: (packet as ToolCallMetadata).tool_args,
                tool_result: (packet as ToolCallMetadata).tool_result,
              };

              if (!toolCall.tool_name.includes("agent")) {
                if (
                  !toolCall.tool_result ||
                  toolCall.tool_result == undefined
                ) {
                  updateChatState("toolBuilding", frozenSessionId);
                } else {
                  updateChatState("streaming", frozenSessionId);
                }

                // This will be consolidated in upcoming tool calls udpate,
                // but for now, we need to set query as early as possible
                if (toolCall.tool_name == SEARCH_TOOL_NAME) {
                  query = toolCall.tool_args["query"];
                }
              } else {
                toolCall = null;
              }
            } else if (Object.hasOwn(packet, "file_ids")) {
              aiMessageImages = (packet as FileChatDisplay).file_ids.map(
                (fileId) => {
                  return {
                    id: fileId,
                    type: ChatFileType.IMAGE,
                  };
                }
              );
            } else if (
              Object.hasOwn(packet, "error") &&
              (packet as any).error != null
            ) {
              if (
                sub_questions.length > 0 &&
                sub_questions
                  .filter((q) => q.level === 0)
                  .every((q) => q.is_stopped === true)
              ) {
                setUncaughtError((packet as StreamingError).error);
                updateChatState("input");
                setAgenticGenerating(false);
                setAlternativeGeneratingAssistant(null);
                setSubmittedMessage("");

                throw new Error((packet as StreamingError).error);
              } else {
                error = (packet as StreamingError).error;
                stackTrace = (packet as StreamingError).stack_trace;
              }
            } else if (Object.hasOwn(packet, "message_id")) {
              finalMessage = packet as BackendMessage;
            } else if (Object.hasOwn(packet, "stop_reason")) {
              const stop_reason = (packet as StreamStopInfo).stop_reason;
              if (stop_reason === StreamStopReason.CONTEXT_LENGTH) {
                updateCanContinue(true, frozenSessionId);
              }
            }

            // on initial message send, we insert a dummy system message
            // set this as the parent here if no parent is set
            parentMessage =
              parentMessage || frozenMessageMap?.get(SYSTEM_MESSAGE_ID)!;

            const updateFn = (messages: Message[]) => {
              const replacementsMap = regenerationRequest
                ? new Map([
                  [
                    regenerationRequest?.parentMessage?.messageId,
                    regenerationRequest?.parentMessage?.messageId,
                  ],
                  [
                    regenerationRequest?.messageId,
                    initialFetchDetails?.assistant_message_id,
                  ],
                ] as [number, number][])
                : null;

              const newMessageDetails = upsertToCompleteMessageMap({
                messages: messages,
                replacementsMap: replacementsMap,
                // Pass the latest map state
                completeMessageMapOverride: currentMap,
                chatSessionId: frozenSessionId!,
              });
              currentMap = newMessageDetails.messageMap;
              return newMessageDetails;
            };

            const systemMessageId = Math.min(...mapKeys);
            updateFn([
              {
                messageId: regenerationRequest
                  ? regenerationRequest?.parentMessage?.messageId!
                  : initialFetchDetails.user_message_id!,
                message: currMessage,
                type: "user",
                files: files,
                toolCall: null,
                // in the frontend, every message should have a parent ID
                parentMessageId: lastSuccessfulMessageId ?? systemMessageId,
                childrenMessageIds: [
                  ...(regenerationRequest?.parentMessage?.childrenMessageIds ||
                    []),
                  initialFetchDetails.assistant_message_id!,
                ],
                latestChildMessageId: initialFetchDetails.assistant_message_id,
              },
              {
                isStreamingQuestions: isStreamingQuestions,
                is_generating: is_generating,
                isImprovement: isImprovement,
                messageId: initialFetchDetails.assistant_message_id!,
                message: error || answer,
                second_level_message: second_level_answer,
                type: error ? "error" : "assistant",
                retrievalType,
                query: finalMessage?.rephrased_query || query,
                documents: documents,
                citations: finalMessage?.citations || {},
                files: finalMessage?.files || aiMessageImages || [],
                toolCall: finalMessage?.tool_call || toolCall,
                parentMessageId: regenerationRequest
                  ? regenerationRequest?.parentMessage?.messageId!
                  : initialFetchDetails.user_message_id,
                alternateAssistantID: alternativeAssistant?.id,
                stackTrace: stackTrace,
                overridden_model: finalMessage?.overridden_model,
                stopReason: stopReason,
                sub_questions: sub_questions,
                second_level_generating: second_level_generating,
                agentic_docs: agenticDocs,
                is_agentic: isAgentic,
              },
              ...(includeAgentic
                ? [
                  {
                    messageId: secondLevelMessageId!,
                    message: second_level_answer,
                    type: "assistant" as const,
                    files: [],
                    toolCall: null,
                    parentMessageId:
                      initialFetchDetails.assistant_message_id!,
                  },
                ]
                : []),
            ]);
          }
        }
      }
    } catch (e: any) {
      console.log("Error:", e);
      const errorMsg = e.message;
      const newMessageDetails = upsertToCompleteMessageMap({
        messages: [
          {
            messageId:
              initialFetchDetails?.user_message_id || TEMP_USER_MESSAGE_ID,
            message: currMessage,
            type: "user",
            files: currentMessageFiles,
            toolCall: null,
            parentMessageId: parentMessage?.messageId || SYSTEM_MESSAGE_ID,
          },
          {
            messageId:
              initialFetchDetails?.assistant_message_id ||
              TEMP_ASSISTANT_MESSAGE_ID,
            message: errorMsg,
            type: "error",
            files: aiMessageImages || [],
            toolCall: null,
            parentMessageId:
              initialFetchDetails?.user_message_id || TEMP_USER_MESSAGE_ID,
          },
        ],
        completeMessageMapOverride: currentMap,
      });
      currentMap = newMessageDetails.messageMap;
    }
    console.log("Finished streaming");
    setAgenticGenerating(false);
    resetRegenerationState(currentSessionId());

    updateChatState("input");
    if (isNewSession) {
      console.log("Setting up new session");
      if (finalMessage) {
        setSelectedMessageForDocDisplay(finalMessage.message_id);
      }

      if (!searchParamBasedChatSessionName) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await nameChatSession(currChatSessionId);
        refreshChatSessions();
      }

      // NOTE: don't switch pages if the user has navigated away from the chat
      if (
        currChatSessionId === chatSessionIdRef.current ||
        chatSessionIdRef.current === null
      ) {
        const newUrl = buildChatUrl(searchParams, currChatSessionId, null);
        // newUrl is like /chat?chatId=10
        // current page is like /chat

        if (pathname == "/chat" && !navigatingAway.current) {
          router.push(newUrl, { scroll: false });
        }
      }
    }
    if (
      finalMessage?.context_docs &&
      finalMessage.context_docs.top_documents.length > 0 &&
      retrievalType === RetrievalType.Search
    ) {
      setSelectedMessageForDocDisplay(finalMessage.message_id);
    }
    setAlternativeGeneratingAssistant(null);
    setSubmittedMessage("");
  };

  const onFeedback = async (
    messageId: number,
    feedbackType: FeedbackType,
    feedbackDetails: string,
    predefinedFeedback: string | undefined
  ) => {
    if (chatSessionIdRef.current === null) {
      return;
    }

    const response = await handleChatFeedback(
      messageId,
      feedbackType,
      feedbackDetails,
      predefinedFeedback
    );

    if (response.ok) {
      setPopup({
        message: "Thanks for your feedback!",
        type: "success",
      });
    } else {
      const responseJson = await response.json();
      const errorMsg = responseJson.detail || responseJson.message;
      setPopup({
        message: `Failed to submit feedback - ${errorMsg}`,
        type: "error",
      });
    }
  };

  const handleImageUpload = async (
    acceptedFiles: File[],
    intent: UploadIntent
  ) => {
    const [_, llmModel] = getFinalLLM(
      llmProviders,
      liveAssistant,
      llmManager.currentLlm
    );
    const llmAcceptsImages = modelSupportsImageInput(llmProviders, llmModel);

    const imageFiles = acceptedFiles.filter((file) =>
      file.type.startsWith("image/")
    );

    if (imageFiles.length > 0 && !llmAcceptsImages) {
      setPopup({
        type: "error",
        message:
          "The current model does not support image input. Please select a model with Vision support.",
      });
      return;
    }

    updateChatState("uploading", currentSessionId());

    const newlyUploadedFileDescriptors: FileDescriptor[] = [];

    for (let file of acceptedFiles) {
      const formData = new FormData();
      formData.append("files", file);
      const response: FileResponse[] = await uploadFile(formData, null);

      if (response.length > 0) {
        const uploadedFile = response[0];

        if (intent == UploadIntent.ADD_TO_DOCUMENTS) {
          addSelectedFile(uploadedFile);
        } else {
          const newFileDescriptor: FileDescriptor = {
            // Use file_id (storage ID) if available, otherwise fallback to DB id
            // Ensure it's a string as FileDescriptor expects
            id: uploadedFile.file_id
              ? String(uploadedFile.file_id)
              : String(uploadedFile.id),
            type: uploadedFile.chat_file_type
              ? uploadedFile.chat_file_type
              : ChatFileType.PLAIN_TEXT,
            name: uploadedFile.name,
            isUploading: false, // Mark as successfully uploaded
          };

          setCurrentMessageFiles((prev) => [...prev, newFileDescriptor]);
        }
      } else {
        setPopup({
          type: "error",
          message: "Failed to upload file",
        });
      }
    }

    updateChatState("input", currentSessionId());
  };

  // Used to maintain a "time out" for history sidebar so our existing refs can have time to process change
  const [untoggled, setUntoggled] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const explicitlyUntoggle = () => {
    setShowHistorySidebar(false);

    setUntoggled(true);
    setTimeout(() => {
      setUntoggled(false);
    }, 200);
  };
  const toggleSidebar = () => {
    if (user?.is_anonymous_user) {
      return;
    }
    Cookies.set(
      SIDEBAR_TOGGLED_COOKIE_NAME,
      String(!sidebarVisible).toLocaleLowerCase()
    ),
    {
      path: "/",
    };

    toggle();
  };
  const removeToggle = () => {
    setShowHistorySidebar(false);
    toggle(false);
  };

  const waitForScrollRef = useRef(false);
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  useSidebarVisibility({
    sidebarVisible,
    sidebarElementRef,
    showDocSidebar: showHistorySidebar,
    setShowDocSidebar: setShowHistorySidebar,
    setToggled: removeToggle,
    mobile: settings?.isMobile,
    isAnonymousUser: user?.is_anonymous_user,
  });

  // Virtualization + Scrolling related effects and functions
  const scrollInitialized = useRef(false);

  const imageFileInMessageHistory = useMemo(() => {
    return messageHistory
      .filter((message) => message.type === "user")
      .some((message) =>
        message.files.some((file) => file.type === ChatFileType.IMAGE)
      );
  }, [messageHistory]);

  useSendMessageToParent();

  useEffect(() => {
    if (liveAssistant) {
      const hasSearchTool = liveAssistant.tools.some(
        (tool) =>
          tool.in_code_tool_id === SEARCH_TOOL_ID &&
          liveAssistant.user_file_ids?.length == 0 &&
          liveAssistant.user_folder_ids?.length == 0
      );
      setRetrievalEnabled(hasSearchTool);
      if (!hasSearchTool) {
        filterManager.clearFilters();
      }
    }
  }, [liveAssistant]);

  const [retrievalEnabled, setRetrievalEnabled] = useState(() => {
    if (liveAssistant) {
      return liveAssistant.tools.some(
        (tool) =>
          tool.in_code_tool_id === SEARCH_TOOL_ID &&
          liveAssistant.user_file_ids?.length == 0 &&
          liveAssistant.user_folder_ids?.length == 0
      );
    }
    return false;
  });

  useEffect(() => {
    if (!retrievalEnabled) {
      setDocumentSidebarVisible(false);
    }
  }, [retrievalEnabled]);

  const [stackTraceModalContent, setStackTraceModalContent] = useState<
    string | null
  >(null);

  const innerSidebarElementRef = useRef<HTMLDivElement>(null);
  const [settingsToggled, setSettingsToggled] = useState(false);

  const [selectedDocuments, setSelectedDocuments] = useState<OnyxDocument[]>(
    []
  );
  const [selectedDocumentTokens, setSelectedDocumentTokens] = useState(0);

  const currentPersona = alternativeAssistant || liveAssistant;

  const HORIZON_DISTANCE = 800;
  const handleScroll = useCallback(() => {
    const scrollDistance =
      endDivRef?.current?.getBoundingClientRect()?.top! -
      inputRef?.current?.getBoundingClientRect()?.top!;
    scrollDist.current = scrollDistance;
    setAboveHorizon(scrollDist.current > HORIZON_DISTANCE);
  }, []);

  useEffect(() => {
    const handleSlackChatRedirect = async () => {
      if (!slackChatId) return;

      // Set isReady to false before starting retrieval to display loading text
      setIsReady(false);

      try {
        const response = await fetch("/api/chat/seed-chat-session-from-slack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_session_id: slackChatId,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to seed chat from Slack");
        }

        const data = await response.json();

        router.push(data.redirect_url);
      } catch (error) {
        console.error("Error seeding chat from Slack:", error);
        setPopup({
          message: "Failed to load chat from Slack",
          type: "error",
        });
      }
    };

    handleSlackChatRedirect();
  }, [searchParams, router]);

  useEffect(() => {
    llmManager.updateImageFilesPresent(imageFileInMessageHistory);
  }, [imageFileInMessageHistory]);

  const pathname = usePathname();
  useEffect(() => {
    return () => {
      // Cleanup which only runs when the component unmounts (i.e. when you navigate away).
      const currentSession = currentSessionId();
      const controller = abortControllersRef.current.get(currentSession);
      if (controller) {
        controller.abort();
        navigatingAway.current = true;
        setAbortControllers((prev) => {
          const newControllers = new Map(prev);
          newControllers.delete(currentSession);
          return newControllers;
        });
      }
    };
  }, [pathname]);

  const navigatingAway = useRef(false);
  // Keep a ref to abortControllers to ensure we always have the latest value
  const abortControllersRef = useRef(abortControllers);
  useEffect(() => {
    abortControllersRef.current = abortControllers;
  }, [abortControllers]);
  useEffect(() => {
    const calculateTokensAndUpdateSearchMode = async () => {
      if (selectedFiles.length > 0 || selectedFolders.length > 0) {
        try {
          // Prepare the query parameters for the API call
          const fileIds = selectedFiles.map((file: FileResponse) => file.id);
          const folderIds = selectedFolders.map(
            (folder: FolderResponse) => folder.id
          );

          // Build the query string
          const queryParams = new URLSearchParams();
          fileIds.forEach((id) =>
            queryParams.append("file_ids", id.toString())
          );
          folderIds.forEach((id) =>
            queryParams.append("folder_ids", id.toString())
          );

          // Make the API call to get token estimate
          const response = await fetch(
            `/api/user/file/token-estimate?${queryParams.toString()}`
          );

          if (!response.ok) {
            console.error("Failed to fetch token estimate");
            return;
          }
        } catch (error) {
          console.error("Error calculating tokens:", error);
        }
      }
    };

    calculateTokensAndUpdateSearchMode();
  }, [selectedFiles, selectedFolders, llmManager.currentLlm]);

  useSidebarShortcut(router, toggleSidebar);

  const [sharedChatSession, setSharedChatSession] =
    useState<ChatSession | null>();

  const handleResubmitLastMessage = () => {
    // Grab the last user-type message
    const lastUserMsg = messageHistory
      .slice()
      .reverse()
      .find((m) => m.type === "user");
    if (!lastUserMsg) {
      setPopup({
        message: "No previously-submitted user message found.",
        type: "error",
      });
      return;
    }

    // We call onSubmit, passing a `messageOverride`
    onSubmit({
      messageIdToResend: lastUserMsg.messageId,
      messageOverride: lastUserMsg.message,
    });
  };

  const showShareModal = (chatSession: ChatSession) => {
    setSharedChatSession(chatSession);
  };
  const [showAssistantsModal, setShowAssistantsModal] = useState(false);

  const toggleDocumentSidebar = () => {
    if (!documentSidebarVisible) {
      setDocumentSidebarVisible(true);
    } else {
      setDocumentSidebarVisible(false);
    }
  };

  interface RegenerationRequest {
    messageId: number;
    parentMessage: Message;
    forceSearch?: boolean;
  }

  function createRegenerator(regenerationRequest: RegenerationRequest) {
    // Returns new function that only needs `modelOverRide` to be specified when called
    return async function (modelOverride: LlmDescriptor) {
      return await onSubmit({
        modelOverride,
        messageIdToResend: regenerationRequest.parentMessage.messageId,
        regenerationRequest,
        forceSearch: regenerationRequest.forceSearch,
      });
    };
  }
  if (!user) {
    redirect("/auth/login");
  }

  if (noAssistants)
    return (
      <>
        <HealthCheckBanner />
        <NoAssistantModal isAdmin={isAdmin} />
      </>
    );

  return (
    <>
      <HealthCheckBanner />

      {showApiKeyModal && !shouldShowWelcomeModal && (
        <ApiKeyModal
          hide={() => setShowApiKeyModal(false)}
          setPopup={setPopup}
        />
      )}

      {/* ChatPopup is a custom popup that displays a admin-specified message on initial user visit. 
      Only used in the EE version of the app. */}
      {popup}

      <div className="relative w-full">
        {liveAssistant?.name === "Case Analysis" && hasCaseAnalysisStarted && (
          <div
            className="fixed bottom-4 right-4 z-30 flex justify-end"
            title="Model Confidence"
            style={{
              width: `${gaugeSize}px`,
              transition: "width 0.2s ease-in-out",
            }}
          >
            <GaugeMeter value={caseAnalysisConfidence ?? 0} />
          </div>
        )}
      </div>

      <ChatPopup />

      {currentFeedback && (
        <FeedbackModal
          feedbackType={currentFeedback[0]}
          onClose={() => setCurrentFeedback(null)}
          onSubmit={({ message, predefinedFeedback }) => {
            onFeedback(
              currentFeedback[1],
              currentFeedback[0],
              message,
              predefinedFeedback
            );
            setCurrentFeedback(null);
          }}
        />
      )}

      {(settingsToggled || userSettingsToggled) && (
        <UserSettingsModal
          setPopup={setPopup}
          setCurrentLlm={(newLlm) => llmManager.updateCurrentLlm(newLlm)}
          defaultModel={user?.preferences.default_model!}
          llmProviders={llmProviders}
          onClose={() => {
            setUserSettingsToggled(false);
            setSettingsToggled(false);
          }}
        />
      )}

      {toggleDocSelection && (
        <FilePickerModal
          setPresentingDocument={setPresentingDocument}
          buttonContent="Set as Context"
          isOpen={true}
          onClose={() => setToggleDocSelection(false)}
          onSave={() => {
            setToggleDocSelection(false);
          }}
        />
      )}

      <ChatSearchModal
        open={isChatSearchModalOpen}
        onCloseModal={() => setIsChatSearchModalOpen(false)}
      />

      {retrievalEnabled && documentSidebarVisible && settings?.isMobile && (
        <div className="md:hidden">
          <Modal
            hideDividerForTitle
            onOutsideClick={() => setDocumentSidebarVisible(false)}
            title="Sources"
          >
            <DocumentResults
              agenticMessage={
                aiMessage?.sub_questions?.length! > 0 ||
                  messageHistory.find(
                    (m) => m.messageId === aiMessage?.parentMessageId
                  )?.sub_questions?.length! > 0
                  ? true
                  : false
              }
              humanMessage={humanMessage}
              setPresentingDocument={setPresentingDocument}
              modal={true}
              ref={innerSidebarElementRef}
              closeSidebar={() => {
                setDocumentSidebarVisible(false);
              }}
              selectedMessage={aiMessage}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              selectedDocumentTokens={selectedDocumentTokens}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={true}
              removeHeader
            />
          </Modal>
        </div>
      )}

      {presentingDocument && (
        <TextView
          presentingDocument={presentingDocument}
          onClose={() => setPresentingDocument(null)}
        />
      )}

      {stackTraceModalContent && (
        <ExceptionTraceModal
          onOutsideClick={() => setStackTraceModalContent(null)}
          exceptionTrace={stackTraceModalContent}
        />
      )}

      {sharedChatSession && (
        <ShareChatSessionModal
          assistantId={liveAssistant?.id}
          message={message}
          modelOverride={llmManager.currentLlm}
          chatSessionId={sharedChatSession.id}
          existingSharedStatus={sharedChatSession.shared_status}
          onClose={() => setSharedChatSession(null)}
          onShare={(shared) =>
            setChatSessionSharedStatus(
              shared
                ? ChatSessionSharedStatus.Public
                : ChatSessionSharedStatus.Private
            )
          }
        />
      )}

      {sharingModalVisible && chatSessionIdRef.current !== null && (
        <ShareChatSessionModal
          message={message}
          assistantId={liveAssistant?.id}
          modelOverride={llmManager.currentLlm}
          chatSessionId={chatSessionIdRef.current}
          existingSharedStatus={chatSessionSharedStatus}
          onClose={() => setSharingModalVisible(false)}
        />
      )}

      {showAssistantsModal && (
        <AssistantModal hideModal={() => setShowAssistantsModal(false)} />
      )}

      <div className="fixed inset-0 flex flex-col text-text-dark">
        <div className="h-[100dvh] overflow-y-hidden">
          <div className="w-full">
            <div
              ref={sidebarElementRef}
              className={`
                flex-none
                fixed
                left-0
                z-40
                bg-neutral-200
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${!untoggled && (showHistorySidebar || sidebarVisible)
                  ? "opacity-100 w-[250px] translate-x-0"
                  : "opacity-0 w-[250px] pointer-events-none -translate-x-10"
                }`}
            >
              <div className="w-full relative">
                <HistorySidebar
                  toggleChatSessionSearchModal={() =>
                    setIsChatSearchModalOpen((open) => !open)
                  }
                  liveAssistant={liveAssistant}
                  setShowAssistantsModal={setShowAssistantsModal}
                  explicitlyUntoggle={explicitlyUntoggle}
                  reset={reset}
                  page="chat"
                  ref={innerSidebarElementRef}
                  toggleSidebar={toggleSidebar}
                  toggled={sidebarVisible}
                  existingChats={chatSessions}
                  currentChatSession={selectedChatSession}
                  folders={folders}
                  removeToggle={removeToggle}
                  showShareModal={showShareModal}
                />
              </div>

              <div
                className={`
                flex-none
                fixed
                left-0
                z-40
                bg-background-100
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${documentSidebarVisible &&
                  !settings?.isMobile &&
                  "opacity-100 w-[350px]"
                  }`}
              ></div>
            </div>
          </div>

          <div
            style={{ transition: "width 0.30s ease-out" }}
            className={`
                flex-none 
                fixed
                right-0
                z-[1000]
                h-screen
                transition-all
                duration-300
                ease-in-out
                bg-transparent
                transition-all
                duration-300
                ease-in-out
                h-full
                ${documentSidebarVisible && !settings?.isMobile
                ? "w-[400px]"
                : "w-[0px]"
              }
            `}
          >
            <DocumentResults
              humanMessage={humanMessage}
              agenticMessage={
                aiMessage?.sub_questions?.length! > 0 ||
                  messageHistory.find(
                    (m) => m.messageId === aiMessage?.parentMessageId
                  )?.sub_questions?.length! > 0
                  ? true
                  : false
              }
              setPresentingDocument={setPresentingDocument}
              modal={false}
              ref={innerSidebarElementRef}
              closeSidebar={() =>
                setTimeout(() => setDocumentSidebarVisible(false), 300)
              }
              selectedMessage={aiMessage}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              selectedDocumentTokens={selectedDocumentTokens}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={documentSidebarVisible && !settings?.isMobile}
            />
          </div>

          <BlurBackground
            visible={!untoggled && (showHistorySidebar || sidebarVisible)}
            onClick={() => toggleSidebar()}
          />

          <div
            ref={masterFlexboxRef}
            className="flex h-full w-full overflow-x-hidden"
          >
            <div
              id="scrollableContainer"
              className="flex h-full relative px-2 flex-col w-full"
            >
              {liveAssistant && (
                <FunctionalHeader
                  toggleUserSettings={() => setUserSettingsToggled(true)}
                  sidebarToggled={sidebarVisible}
                  reset={() => setMessage("")}
                  page="chat"
                  setSharingModalVisible={
                    chatSessionIdRef.current !== null
                      ? setSharingModalVisible
                      : undefined
                  }
                  documentSidebarVisible={
                    documentSidebarVisible && !settings?.isMobile
                  }
                  toggleSidebar={toggleSidebar}
                  currentChatSession={selectedChatSession}
                  hideUserDropdown={user?.is_anonymous_user}
                />
              )}

              {documentSidebarInitialWidth !== undefined && isReady ? (
                <Dropzone
                  key={currentSessionId()}
                  onDrop={(acceptedFiles) =>
                    handleImageUpload(
                      acceptedFiles,
                      UploadIntent.ATTACH_TO_MESSAGE
                    )
                  }
                  noClick
                >
                  {({ getRootProps }) => (
                    <div className="flex h-full w-full">
                      {!settings?.isMobile && (
                        <div
                          style={{ transition: "width 0.30s ease-out" }}
                          className={`
                          flex-none 
                          overflow-y-hidden 
                          bg-transparent
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                      `}
                        ></div>
                      )}

                      <div
                        className={`h-full w-full relative flex-auto transition-margin duration-300 overflow-x-auto mobile:pb-12 desktop:pb-[100px]`}
                        {...getRootProps()}
                      >
                        <div
                          onScroll={handleScroll}
                          className={`w-full h-[calc(100vh-160px)] flex flex-col default-scrollbar overflow-y-auto overflow-x-hidden relative`}
                          ref={scrollableDivRef}
                        >
                          {liveAssistant && (
                            <div className="z-20 fixed top-0 pointer-events-none left-0 w-full flex justify-center overflow-visible">
                              {!settings?.isMobile && (
                                <div
                                  style={{ transition: "width 0.30s ease-out" }}
                                  className={`
                                  flex-none 
                                  overflow-y-hidden 
                                  transition-all 
                                  pointer-events-none
                                  duration-300 
                                  ease-in-out
                                  h-full
                                  ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                              `}
                                />
                              )}
                            </div>
                          )}
                          {/* ChatBanner is a custom banner that displays a admin-specified message at 
                      the top of the chat page. Oly used in the EE version of the app. */}
                          {messageHistory.length === 0 &&
                            !isFetchingChatMessages &&
                            currentSessionChatState == "input" &&
                            !loadingError &&
                            !submittedMessage && (
                              <div className="h-full  w-[95%] mx-auto flex flex-col justify-center items-center">
                                <ChatIntro selectedPersona={liveAssistant} />

                                <StarterMessages
                                  currentPersona={currentPersona}
                                  onSubmit={(messageOverride) =>
                                    onSubmit({
                                      messageOverride,
                                    })
                                  }
                                />
                              </div>
                            )}
                          <div
                            style={{ overflowAnchor: "none" }}
                            key={currentSessionId()}
                            className={
                              (hasPerformedInitialScroll ? "" : " hidden ") +
                              "desktop:-ml-4 w-full mx-auto " +
                              "absolute mobile:top-0 desktop:top-0 left-0 " +
                              (settings?.enterpriseSettings
                                ?.two_lines_for_chat_header
                                ? "pt-20 "
                                : "pt-4 ")
                            }
                          // NOTE: temporarily removing this to fix the scroll bug
                          // (hasPerformedInitialScroll ? "" : "invisible")
                          >
                            {messageHistory.map((message, i) => {
                              const messageMap = currentMessageMap(
                                completeMessageDetail
                              );

                              if (
                                currentRegenerationState()?.finalMessageIndex &&
                                currentRegenerationState()?.finalMessageIndex! <
                                message.messageId
                              ) {
                                return <></>;
                              }

                              const messageReactComponentKey = `${i}-${currentSessionId()}`;
                              const parentMessage = message.parentMessageId
                                ? messageMap.get(message.parentMessageId)
                                : null;
                              if (message.type === "user") {
                                if (
                                  (currentSessionChatState == "loading" &&
                                    i == messageHistory.length - 1) ||
                                  (currentSessionRegenerationState?.regenerating &&
                                    message.messageId >=
                                    currentSessionRegenerationState?.finalMessageIndex!)
                                ) {
                                  return <></>;
                                }
                                const nextMessage =
                                  messageHistory.length > i + 1
                                    ? messageHistory[i + 1]
                                    : null;
                                return (
                                  <div
                                    id={`message-${message.messageId}`}
                                    key={messageReactComponentKey}
                                  >
                                    <HumanMessage
                                      setPresentingDocument={
                                        setPresentingDocument
                                      }
                                      disableSwitchingForStreaming={
                                        (nextMessage &&
                                          nextMessage.is_generating) ||
                                        false
                                      }
                                      stopGenerating={stopGenerating}
                                      content={message.message}
                                      files={message.files}
                                      messageId={message.messageId}
                                      onEdit={(editedContent) => {
                                        const parentMessageId =
                                          message.parentMessageId!;
                                        const parentMessage =
                                          messageMap.get(parentMessageId)!;
                                        upsertToCompleteMessageMap({
                                          messages: [
                                            {
                                              ...parentMessage,
                                              latestChildMessageId: null,
                                            },
                                          ],
                                        });
                                        onSubmit({
                                          messageIdToResend:
                                            message.messageId || undefined,
                                          messageOverride: editedContent,
                                        });
                                      }}
                                      otherMessagesCanSwitchTo={
                                        parentMessage?.childrenMessageIds || []
                                      }
                                      onMessageSelection={(messageId) => {
                                        const newCompleteMessageMap = new Map(
                                          messageMap
                                        );
                                        newCompleteMessageMap.get(
                                          message.parentMessageId!
                                        )!.latestChildMessageId = messageId;
                                        updateCompleteMessageDetail(
                                          currentSessionId(),
                                          newCompleteMessageMap
                                        );
                                        setSelectedMessageForDocDisplay(
                                          messageId
                                        );
                                        // set message as latest so we can edit this message
                                        // and so it sticks around on page reload
                                        setMessageAsLatest(messageId);
                                      }}
                                    />
                                  </div>
                                );
                              } else if (message.type === "assistant") {
                                const previousMessage =
                                  i !== 0 ? messageHistory[i - 1] : null;

                                const currentAlternativeAssistant =
                                  message.alternateAssistantID != null
                                    ? availableAssistants.find(
                                      (persona) =>
                                        persona.id ==
                                        message.alternateAssistantID
                                    )
                                    : null;

                                if (
                                  (currentSessionChatState == "loading" &&
                                    i > messageHistory.length - 1) ||
                                  (currentSessionRegenerationState?.regenerating &&
                                    message.messageId >
                                    currentSessionRegenerationState?.finalMessageIndex!)
                                ) {
                                  return <></>;
                                }
                                if (parentMessage?.type == "assistant") {
                                  return <></>;
                                }
                                const secondLevelMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]
                                    : undefined;

                                const secondLevelAssistantMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]?.message
                                    : undefined;

                                const agenticDocs =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]?.documents
                                    : undefined;

                                const nextMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]
                                    : undefined;

                                const attachedFileDescriptors =
                                  previousMessage?.files.filter(
                                    (file) =>
                                      file.type == ChatFileType.USER_KNOWLEDGE
                                  );
                                const userFiles = allUserFiles?.filter((file) =>
                                  attachedFileDescriptors?.some(
                                    (descriptor) =>
                                      descriptor.id === file.file_id
                                  )
                                );

                                return (
                                  <div
                                    className="text-text"
                                    id={`message-${message.messageId}`}
                                    key={messageReactComponentKey}
                                    ref={
                                      i == messageHistory.length - 1
                                        ? lastMessageRef
                                        : null
                                    }
                                  >
                                    {message.is_agentic ? (
                                      <AgenticMessage
                                        resubmit={handleResubmitLastMessage}
                                        error={uncaughtError}
                                        isStreamingQuestions={
                                          message.isStreamingQuestions ?? false
                                        }
                                        isGenerating={
                                          message.is_generating ?? false
                                        }
                                        docSidebarToggled={
                                          documentSidebarVisible &&
                                          (selectedMessageForDocDisplay ==
                                            message.messageId ||
                                            selectedMessageForDocDisplay ==
                                            secondLevelMessage?.messageId)
                                        }
                                        isImprovement={
                                          message.isImprovement ||
                                          nextMessage?.isImprovement
                                        }
                                        secondLevelGenerating={
                                          (message.second_level_generating &&
                                            currentSessionChatState !==
                                            "input") ||
                                          false
                                        }
                                        secondLevelSubquestions={message.sub_questions?.filter(
                                          (subQuestion) =>
                                            subQuestion.level === 1
                                        )}
                                        secondLevelAssistantMessage={
                                          (message.second_level_message &&
                                            message.second_level_message.length >
                                            0
                                            ? message.second_level_message
                                            : secondLevelAssistantMessage) ||
                                          undefined
                                        }
                                        subQuestions={
                                          message.sub_questions?.filter(
                                            (subQuestion) =>
                                              subQuestion.level === 0
                                          ) || []
                                        }
                                        agenticDocs={
                                          message.agentic_docs || agenticDocs
                                        }
                                        toggleDocDisplay={(
                                          agentic: boolean
                                        ) => {
                                          if (agentic) {
                                            setSelectedMessageForDocDisplay(
                                              message.messageId
                                            );
                                          } else {
                                            setSelectedMessageForDocDisplay(
                                              secondLevelMessage
                                                ? secondLevelMessage.messageId
                                                : null
                                            );
                                          }
                                        }}
                                        docs={
                                          message?.documents &&
                                            message?.documents.length > 0
                                            ? message?.documents
                                            : parentMessage?.documents
                                        }
                                        setPresentingDocument={
                                          setPresentingDocument
                                        }
                                        continueGenerating={
                                          i == messageHistory.length - 1 &&
                                            currentCanContinue()
                                            ? continueGenerating
                                            : undefined
                                        }
                                        overriddenModel={
                                          message.overridden_model
                                        }
                                        regenerate={
                                          liveAssistant?.name === "Case Analysis" ||
                                            liveAssistant?.id === -4 ||
                                            liveAssistant?.name === "Deep Search" ||
                                            liveAssistant?.id === -5 ||
                                            liveAssistant?.name === "Legacy Search" ||
                                            liveAssistant?.id === -6
                                            ? undefined
                                            : createRegenerator({
                                              messageId: message.messageId,
                                              parentMessage: parentMessage!,
                                            })
                                        }
                                        otherMessagesCanSwitchTo={
                                          parentMessage?.childrenMessageIds ||
                                          []
                                        }
                                        onMessageSelection={(messageId) => {
                                          const newCompleteMessageMap = new Map(
                                            messageMap
                                          );
                                          newCompleteMessageMap.get(
                                            message.parentMessageId!
                                          )!.latestChildMessageId = messageId;

                                          updateCompleteMessageDetail(
                                            currentSessionId(),
                                            newCompleteMessageMap
                                          );

                                          setSelectedMessageForDocDisplay(
                                            messageId
                                          );
                                          // set message as latest so we can edit this message
                                          // and so it sticks around on page reload
                                          setMessageAsLatest(messageId);
                                        }}
                                        isActive={
                                          messageHistory.length - 1 == i ||
                                          messageHistory.length - 2 == i
                                        }
                                        selectedDocuments={selectedDocuments}
                                        toggleDocumentSelection={(
                                          second: boolean
                                        ) => {
                                          if (
                                            (!second &&
                                              !documentSidebarVisible) ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                              message.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }
                                          if (
                                            (second &&
                                              !documentSidebarVisible) ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                              secondLevelMessage?.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }

                                          setSelectedMessageForDocDisplay(
                                            second
                                              ? secondLevelMessage?.messageId ||
                                              null
                                              : message.messageId
                                          );
                                        }}
                                        currentPersona={liveAssistant}
                                        alternativeAssistant={
                                          currentAlternativeAssistant
                                        }
                                        messageId={message.messageId}
                                        content={message.message}
                                        files={message.files}
                                        query={
                                          messageHistory[i]?.query || undefined
                                        }
                                        citedDocuments={getCitedDocumentsFromMessage(
                                          message
                                        )}
                                        toolCall={message.toolCall}
                                        isComplete={
                                          i !== messageHistory.length - 1 ||
                                          (currentSessionChatState !=
                                            "streaming" &&
                                            currentSessionChatState !=
                                            "toolBuilding")
                                        }
                                        handleFeedback={
                                          i === messageHistory.length - 1 &&
                                            currentSessionChatState != "input"
                                            ? undefined
                                            : (feedbackType: FeedbackType) =>
                                              setCurrentFeedback([
                                                feedbackType,
                                                message.messageId as number,
                                              ])
                                        }
                                      />
                                    ) : (
                                      <AIMessage
                                        userKnowledgeFiles={userFiles}
                                        docs={
                                          message?.documents &&
                                            message?.documents.length > 0
                                            ? message?.documents
                                            : parentMessage?.documents
                                        }
                                        setPresentingDocument={
                                          setPresentingDocument
                                        }
                                        index={i}
                                        continueGenerating={
                                          i == messageHistory.length - 1 &&
                                            currentCanContinue()
                                            ? continueGenerating
                                            : undefined
                                        }
                                        overriddenModel={
                                          message.overridden_model
                                        }
                                        regenerate={
                                          liveAssistant?.name === "Case Analysis" ||
                                            liveAssistant?.id === -4 ||
                                            liveAssistant?.name === "Deep Search" ||
                                            liveAssistant?.id === -5 ||
                                            liveAssistant?.name === "Legacy Search" ||
                                            liveAssistant?.id === -6
                                            ? undefined
                                            : createRegenerator({
                                              messageId: message.messageId,
                                              parentMessage: parentMessage!,
                                            })
                                        }
                                        otherMessagesCanSwitchTo={
                                          parentMessage?.childrenMessageIds ||
                                          []
                                        }
                                        onMessageSelection={(messageId) => {
                                          const newCompleteMessageMap = new Map(
                                            messageMap
                                          );
                                          newCompleteMessageMap.get(
                                            message.parentMessageId!
                                          )!.latestChildMessageId = messageId;

                                          updateCompleteMessageDetail(
                                            currentSessionId(),
                                            newCompleteMessageMap
                                          );

                                          setSelectedMessageForDocDisplay(
                                            messageId
                                          );
                                          // set message as latest so we can edit this message
                                          // and so it sticks around on page reload
                                          setMessageAsLatest(messageId);
                                        }}
                                        isActive={
                                          messageHistory.length - 1 == i
                                        }
                                        selectedDocuments={selectedDocuments}
                                        toggleDocumentSelection={() => {
                                          if (
                                            !documentSidebarVisible ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                              message.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }

                                          setSelectedMessageForDocDisplay(
                                            message.messageId
                                          );
                                        }}
                                        currentPersona={liveAssistant}
                                        alternativeAssistant={
                                          currentAlternativeAssistant
                                        }
                                        messageId={message.messageId}
                                        content={message.message}
                                        files={message.files}
                                        query={
                                          messageHistory[i]?.query || undefined
                                        }
                                        citedDocuments={getCitedDocumentsFromMessage(
                                          message
                                        )}
                                        toolCall={message.toolCall}
                                        isComplete={
                                          i !== messageHistory.length - 1 ||
                                          (currentSessionChatState !=
                                            "streaming" &&
                                            currentSessionChatState !=
                                            "toolBuilding")
                                        }
                                        hasDocs={
                                          (message.documents &&
                                            message.documents.length > 0) ===
                                          true
                                        }
                                        handleFeedback={
                                          i === messageHistory.length - 1 &&
                                            currentSessionChatState != "input"
                                            ? undefined
                                            : (feedbackType) =>
                                              setCurrentFeedback([
                                                feedbackType,
                                                message.messageId as number,
                                              ])
                                        }
                                        handleSearchQueryEdit={
                                          i === messageHistory.length - 1 &&
                                            currentSessionChatState == "input"
                                            ? (newQuery) => {
                                              if (!previousMessage) {
                                                setPopup({
                                                  type: "error",
                                                  message:
                                                    "Cannot edit query of first message - please refresh the page and try again.",
                                                });
                                                return;
                                              }
                                              if (
                                                previousMessage.messageId ===
                                                null
                                              ) {
                                                setPopup({
                                                  type: "error",
                                                  message:
                                                    "Cannot edit query of a pending message - please wait a few seconds and try again.",
                                                });
                                                return;
                                              }
                                              onSubmit({
                                                messageIdToResend:
                                                  previousMessage.messageId,
                                                queryOverride: newQuery,
                                                alternativeAssistantOverride:
                                                  currentAlternativeAssistant,
                                              });
                                            }
                                            : undefined
                                        }
                                        handleForceSearch={() => {
                                          if (
                                            previousMessage &&
                                            previousMessage.messageId
                                          ) {
                                            createRegenerator({
                                              messageId: message.messageId,
                                              parentMessage: parentMessage!,
                                              forceSearch: true,
                                            })(llmManager.currentLlm);
                                          } else {
                                            setPopup({
                                              type: "error",
                                              message:
                                                "Failed to force search - please refresh the page and try again.",
                                            });
                                          }
                                        }}
                                        retrievalDisabled={
                                          currentAlternativeAssistant
                                            ? !personaIncludesRetrieval(
                                              currentAlternativeAssistant!
                                            )
                                            : !retrievalEnabled
                                        }
                                      />
                                    )}
                                  </div>
                                );
                              } else {
                                return (
                                  <div key={messageReactComponentKey}>
                                    <AIMessage
                                      setPresentingDocument={
                                        setPresentingDocument
                                      }
                                      currentPersona={liveAssistant}
                                      messageId={message.messageId}
                                      content={
                                        <ErrorBanner
                                          resubmit={handleResubmitLastMessage}
                                          error={message.message}
                                          showStackTrace={
                                            message.stackTrace
                                              ? () =>
                                                setStackTraceModalContent(
                                                  message.stackTrace!
                                                )
                                              : undefined
                                          }
                                        />
                                      }
                                    />
                                  </div>
                                );
                              }
                            })}

                            {(currentSessionChatState == "loading" ||
                              (loadingError &&
                                !currentSessionRegenerationState?.regenerating &&
                                messageHistory[messageHistory.length - 1]
                                  ?.type != "user")) && (
                                <HumanMessage
                                  setPresentingDocument={setPresentingDocument}
                                  key={-2}
                                  messageId={-1}
                                  content={submittedMessage}
                                />
                              )}

                            {currentSessionChatState == "loading" && (
                              <div
                                key={`${messageHistory.length}-${chatSessionIdRef.current}`}
                              >
                                <AIMessage
                                  setPresentingDocument={setPresentingDocument}
                                  key={-3}
                                  currentPersona={liveAssistant}
                                  alternativeAssistant={
                                    alternativeGeneratingAssistant ??
                                    alternativeAssistant
                                  }
                                  messageId={null}
                                  content={
                                    <div
                                      key={"Generating"}
                                      className="mr-auto relative inline-block"
                                    >
                                      <span className="text-sm loading-text">
                                        Thinking...
                                      </span>
                                    </div>
                                  }
                                />
                              </div>
                            )}

                            {loadingError && (
                              <div key={-1}>
                                <AIMessage
                                  setPresentingDocument={setPresentingDocument}
                                  currentPersona={liveAssistant}
                                  messageId={-1}
                                  content={
                                    <p className="text-red-700 text-sm my-auto">
                                      {loadingError}
                                    </p>
                                  }
                                />
                              </div>
                            )}
                            {messageHistory.length > 0 && (
                              <div
                                style={{
                                  height: !autoScrollEnabled
                                    ? getContainerHeight()
                                    : undefined,
                                }}
                              />
                            )}

                            {/* Pagination for Legacy Search - Judgements */}
                            {showLegacyPager && (() => {
                              const entry = pager[selectedHistory!.id];
                              const current = entry.currentPage;
                              const total = entry.totalPages;
                              const items = pageList(current, total);

                              return (
                                <div className="my-4 flex items-center justify-center gap-2">
                                  {/* Prev */}
                                  <button
                                    onClick={() => goToPage(selectedHistory!.id, current - 1)}
                                    disabled={current === 1 || loadingPageFor === `${selectedHistory!.id}:${current - 1}`}
                                    className={`px-3 py-1 rounded-md border text-sm ${current === 1
                                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                      : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                      }`}
                                    title="Previous page"
                                  >
                                    Prev
                                  </button>

                                  {/* Page numbers with ellipses */}
                                  {items.map((p, i) =>
                                    p === '…' ? (
                                      <span key={`el-${i}`} className="px-2 text-gray-400 select-none">…</span>
                                    ) : (
                                      <button
                                        key={`p-${p}`}
                                        onClick={() => goToPage(selectedHistory!.id, p as number)}
                                        disabled={p === current || loadingPageFor === `${selectedHistory!.id}:${p}`}
                                        className={`px-3 py-1 rounded-md border text-sm ${p === current
                                          ? "bg-gray-900 text-white border-gray-900"
                                          : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                          }`}
                                        title={`Go to page ${p}`}
                                      >
                                        {p}
                                      </button>
                                    )
                                  )}

                                  {/* Next */}
                                  <button
                                    onClick={() => goToPage(selectedHistory!.id, current + 1)}
                                    disabled={current === total || loadingPageFor === `${selectedHistory!.id}:${current + 1}`}
                                    className={`px-3 py-1 rounded-md border text-sm ${current === total
                                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                      : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                      }`}
                                    title="Next page"
                                  >
                                    Next
                                  </button>
                                </div>
                              );
                            })()}

                            {/* Pagination for Legacy Search — Statutes */}
                            {showLegacyPagerStatutes && (() => {
                              const entry = pager[selectedHistory!.id];
                              const current = entry.currentPage;
                              const total = entry.totalPages;
                              const items = pageList(current, total);

                              return (
                                <div className="my-4 flex items-center justify-center gap-2">
                                  {/* Prev */}
                                  <button
                                    onClick={() => goToPageStatutes(selectedHistory!.id, current - 1)}
                                    disabled={current === 1 || loadingPageFor === `${selectedHistory!.id}:${current - 1}`}
                                    className={`px-3 py-1 rounded-md border text-sm ${current === 1
                                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                      : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                      }`}
                                    title="Previous page"
                                  >
                                    Prev
                                  </button>

                                  {/* Page numbers with ellipses */}
                                  {items.map((p, i) =>
                                    p === '…' ? (
                                      <span key={`el-s-${i}`} className="px-2 text-gray-400 select-none">…</span>
                                    ) : (
                                      <button
                                        key={`ps-${p}`}
                                        onClick={() => goToPageStatutes(selectedHistory!.id, p as number)}
                                        disabled={p === current || loadingPageFor === `${selectedHistory!.id}:${p}`}
                                        className={`px-3 py-1 rounded-md border text-sm ${p === current
                                          ? "bg-gray-900 text-white border-gray-900"
                                          : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                          }`}
                                        title={`Go to page ${p}`}
                                      >
                                        {p}
                                      </button>
                                    )
                                  )}

                                  {/* Next */}
                                  <button
                                    onClick={() => goToPageStatutes(selectedHistory!.id, current + 1)}
                                    disabled={current === total || loadingPageFor === `${selectedHistory!.id}:${current + 1}`}
                                    className={`px-3 py-1 rounded-md border text-sm ${current === total
                                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                      : "bg-white text-gray-800 hover:bg-gray-50 border-gray-300"
                                      }`}
                                    title="Next page"
                                  >
                                    Next
                                  </button>
                                </div>
                              );
                            })()}

                            {/* Some padding at the bottom so the search bar has space at the bottom to not cover the last message*/}
                            <div
                              ref={endPaddingRef}
                              className={
                                liveAssistant?.name === "Case Analysis"
                                  ? "h-[40px]" // or even h-[0px] if you want it tighter
                                  : "h-[95px]"
                              }
                            />

                            <div ref={endDivRef} />
                          </div>
                        </div>
                        <div
                          ref={inputRef}
                          className="absolute pointer-events-none bottom-0 z-10 w-full"
                        >
                          {aboveHorizon && messageHistory.length > 0 && (
                            <div className="mx-auto w-fit !pointer-events-none flex sticky justify-center">
                              <button
                                onClick={() => clientScrollToBottom()}
                                className="p-1 pointer-events-auto text-neutral-700 dark:text-neutral-800 rounded-2xl bg-neutral-200 border border-border  mx-auto "
                              >
                                <FiArrowDown size={18} />
                              </button>
                            </div>
                          )}

                          <div className="pointer-events-auto w-[95%] mx-auto relative mb-8">
                            <ChatInputBar
                              proSearchEnabled={proSearchEnabled}
                              setProSearchEnabled={() => toggleProSearch()}
                              toggleDocumentSidebar={toggleDocumentSidebar}
                              availableSources={sources}
                              availableDocumentSets={documentSets}
                              availableTags={tags}
                              filterManager={filterManager}
                              llmManager={llmManager}
                              removeDocs={() => {
                                clearSelectedDocuments();
                              }}
                              retrievalEnabled={retrievalEnabled}
                              toggleDocSelection={() =>
                                setToggleDocSelection(true)
                              }
                              showConfigureAPIKey={() =>
                                setShowApiKeyModal(true)
                              }
                              selectedDocuments={selectedDocuments}
                              message={message}
                              setMessage={setMessage}
                              stopGenerating={stopGenerating}
                              onSubmit={onSubmit}
                              chatState={currentSessionChatState}
                              alternativeAssistant={alternativeAssistant}
                              selectedAssistant={
                                selectedAssistant || liveAssistant
                              }
                              setAlternativeAssistant={setAlternativeAssistant}
                              setFiles={setCurrentMessageFiles}
                              handleFileUpload={handleImageUpload}
                              textAreaRef={textAreaRef}
                              setShowPopup={setShowPopup}
                            />

                            {selectedAssistant?.name === "Legacy Search" && showPopup && (
                              <div className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-6 lg:p-12">
                                <div
                                  className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                                  onClick={() => { if (!isSearching) setShowPopup(false); }}
                                />
                                <div className="relative bg-white backdrop-blur-lg rounded-2xl shadow-2xl p-8 w-[min(960px,92vw)] max-h-[calc(100vh-10rem)] overflow-y-auto">
                                  <div className="flex justify-between items-start mb-4">
                                    <h3 className="text-2xl font-normal text-gray-900">Search Configuration</h3>
                                    <button
                                      onClick={() => setShowPopup(false)}
                                      className="text-gray-400 hover:text-gray-700 transition text-2xl leading-none ml-4"
                                      title="Close"
                                    >
                                      &times;
                                    </button>
                                  </div>

                                  <div className="mb-4 relative">
                                    <h3 className="font-normal text-gray-800">Select query to refine:</h3>
                                    <p className="text-gray-500 text-sm mb-3">Choose a query to apply keyword or advanced filters.</p>
                                    <div className="relative">
                                      <select
                                        value={selectedQueryId || ''}
                                        onChange={(e) => {
                                          setSelectedQueryId(e.target.value);
                                          setIsDropdownOpen(false); // Close dropdown after selection
                                        }}
                                        onClick={() => setIsDropdownOpen(true)} // Open on click
                                        onBlur={() => {
                                          setTimeout(() => setIsDropdownOpen(false), 150); // Close on blur with slight delay
                                        }}
                                        className="w-full p-2 pr-8 border border-gray-300 rounded-lg focus:outline-none appearance-none bg-white"
                                      >
                                        <option value="" disabled>Select a previous query</option>
                                        {searchHistory
                                          .filter(q => pager[q.id]?.domain === searchDomain) // ← only current domain
                                          .map((q) => {
                                            const dom = pager[q.id]?.domain === 'judgements' ? 'Judgments' : 'Statutes';
                                            return (
                                              <option key={q.id} value={q.id}>
                                                {q.query} — {dom}
                                              </option>
                                            );
                                          })}
                                      </select>

                                      <div className="pointer-events-none absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-600 text-lg">
                                        {isDropdownOpen ? <FiChevronUp /> : <FiChevronDown />}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Keyword Input */}
                                  <div className="mb-6">
                                    <h3 className="font-normal text-gray-800">Refine your search by keyword</h3>
                                    <p className="text-gray-500 text-sm">Add multiple legal keywords one by one (e.g., murder → evidence → arrest) to refine your search.</p>

                                    <div className="mt-4 flex items-center gap-4">
                                      <input
                                        className="flex-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 placeholder-gray-600 text-gray-900"
                                        placeholder="Enter a keyword"
                                        value={newKeyword}
                                        onChange={(e) => setNewKeyword(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault(); // prevent form submission if inside a <form>
                                            addKeyword();
                                          }
                                        }}
                                      />
                                      <button onClick={addKeyword} title="Submit to proceed with refine search">
                                        <img src="/send.png" alt="add" className="h-8 w-8 cursor-pointer" />
                                      </button>
                                    </div>

                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {keywords.map(item => (
                                        <div
                                          key={item}
                                          className="flex items-center px-3 py-1 text-sm text-gray-600 border border-gray-300 rounded-full bg-white group hover:bg-red-500 hover:text-white transition cursor-pointer"
                                          onClick={() => removeKeyword(item)}
                                        >
                                          <span>{item}</span>
                                          <IoMdClose className="ml-2 text-base opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  {/* Domain selector: Judgments / Statutes */}
                                  <div className="mb-4">
                                    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden" role="tablist" aria-label="Result Type">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSearchDomain('judgements');
                                          setShowAdvancedOption(false); // collapse when switching domains
                                        }}
                                        className={`px-4 py-2 text-sm ${searchDomain === 'judgements' ? 'bg-gray-900 text-white' : 'bg-white text-gray-800 hover:bg-gray-50'}`}
                                        aria-selected={searchDomain === 'judgements'}
                                        role="tab"
                                      >
                                        Judgments
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSearchDomain('statutes');
                                          setShowAdvancedOption(false); // collapse when switching domains
                                        }}
                                        className={`px-4 py-2 text-sm border-l border-gray-300 ${searchDomain === 'statutes' ? 'bg-gray-900 text-white' : 'bg-white text-gray-800 hover:bg-gray-50'}`}
                                        aria-selected={searchDomain === 'statutes'}
                                        role="tab"
                                      >
                                        Statutes
                                      </button>
                                    </div>
                                  </div>

                                  {/* Advanced Search Block (Judgments only) */}
                                  {searchDomain === 'judgements' && (
                                    <div className="border border-gray-300 rounded-lg p-4 mb-4">
                                      <button
                                        type="button"
                                        onClick={() => setShowAdvancedOption(prev => !prev)}
                                        className="w-full flex justify-between items-center text-left focus:outline-none"
                                      >
                                        <span className="font-medium text-gray-800">Advanced Search</span>
                                        <span className="text-gray-400">{showAdvancedOption ? '▲' : '▼'}</span>
                                      </button>

                                      {showAdvancedOption && (
                                        <p className="text-sm text-gray-500 mt-3">
                                          You can narrow down results by entering a judge&apos;s name, case title, or selecting a date range.
                                        </p>
                                      )}

                                      {!showAdvancedOption && (
                                        <div className="mt-2 text-xs text-gray-500 flex flex-row flex-wrap gap-x-6 gap-y-1">
                                          {judgeName && <span>Judge&apos;s Name: {judgeName}</span>}
                                          {state[0]?.startDate && state[0]?.endDate && (
                                            <span>
                                              Date Range: {state[0].startDate.toLocaleDateString()} – {state[0].endDate.toLocaleDateString()}
                                            </span>
                                          )}
                                          {caseName && <span>Case Title: {caseName}</span>}
                                          {selectedCourts.length > 0 && (
                                            <span>
                                              Courts: {selectedCourts.length > 3
                                                ? `${selectedCourts.slice(0, 3).join(", ")} +${selectedCourts.length - 3} more`
                                                : selectedCourts.join(", ")}
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {showAdvancedOption && (
                                        <>
                                          <hr className="border-gray-300 my-4" />
                                          <div className="grid grid-cols-2 gap-8 mb-4">
                                            <div className="flex flex-col">
                                              <label className="text-sm font-medium text-gray-700 mb-1">Judge&apos;s Name:</label>
                                              <input
                                                type="text"
                                                value={judgeName}
                                                onChange={(e) => setJudgeName(e.target.value)}
                                                className="p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 placeholder-gray-300 text-gray-700"
                                                placeholder="Enter judge's name"
                                              />
                                            </div>
                                            <div className="flex flex-col">
                                              <label className="text-sm font-medium text-gray-700 mb-1">Date:</label>
                                              <div className="flex items-center gap-4">
                                                <TooltipProvider>
                                                  <Tooltip>
                                                    <TooltipTrigger asChild>
                                                      <input
                                                        type="text"
                                                        readOnly
                                                        value={
                                                          state[0]?.startDate && state[0]?.endDate
                                                            ? `${format(state[0].startDate, 'PPP')} - ${format(state[0].endDate, 'PPP')}`
                                                            : ''
                                                        }
                                                        className="flex-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 placeholder-gray-300 text-gray-700 cursor-not-allowed"
                                                        placeholder="Select date range"
                                                      />
                                                    </TooltipTrigger>
                                                    <TooltipContent
                                                      side="top"
                                                      className="text-sm font-medium text-white bg-gray-800 px-3 py-2 rounded shadow-lg"
                                                    >
                                                      You can&apos;t edit this manually. Use the calendar picker.
                                                    </TooltipContent>
                                                  </Tooltip>
                                                </TooltipProvider>
                                                <button onClick={toggleDatePopup}>
                                                  <img src="/Calendar.png" alt="select date" className="h-6" />
                                                </button>
                                                <TooltipProvider>
                                                  <Tooltip>
                                                    <TooltipTrigger asChild>
                                                      <button
                                                        onClick={() => {
                                                          setState([{ startDate: null, endDate: null, key: "selection" }]);
                                                          setJudgeName("");
                                                          setCaseName("");
                                                          setSelectedCourts([]); // keep empty (no SC, no HC)
                                                        }}
                                                        className="text-sm text-gray-500 underline"
                                                      >
                                                        Clear
                                                      </button>
                                                    </TooltipTrigger>
                                                  </Tooltip>
                                                </TooltipProvider>

                                              </div>
                                            </div>
                                            <div className="col-span-2 flex flex-col">
                                              <label className="text-sm font-medium text-gray-700 mb-1">Case Title:</label>
                                              <input
                                                type="text"
                                                value={caseName}
                                                onChange={(e) => setCaseName(e.target.value)}
                                                className="p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 placeholder-gray-300 text-gray-700"
                                                placeholder="Enter case title"
                                              />
                                            </div>
                                          </div>

                                          {/* Courts */}
                                          <hr className="border-gray-300 my-4" />
                                          <div className="mb-2">
                                            <label className="text-sm font-medium text-gray-700">Courts:</label>
                                            <p className="text-xs text-gray-500 mb-2">
                                              Select Supreme Court and/or one or more High Courts. Leave all unchecked if you don’t want to constrain by court.
                                            </p>

                                            <div className="rounded-lg border border-gray-200 p-3">
                                              {/* Supreme Court */}
                                              <div className="flex items-center mb-2">
                                                <input
                                                  id="sc"
                                                  type="checkbox"
                                                  className="mr-2"
                                                  checked={isCourtChecked("Supreme Court")}
                                                  onChange={() => toggleCourt("Supreme Court")}
                                                />
                                                <label htmlFor="sc" className="text-sm text-gray-700">Supreme Court</label>
                                              </div>

                                              {/* High Courts */}
                                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-y-2">
                                                {loadingCourts && courtsList.length === 0 && (
                                                  <span className="text-xs text-gray-500 col-span-full">Loading courts…</span>
                                                )}
                                                {!loadingCourts && courtsList.map((c) => (
                                                  <label key={c} className="inline-flex items-center text-sm text-gray-700">
                                                    <input
                                                      type="checkbox"
                                                      className="mr-2"
                                                      checked={isCourtChecked(c)}
                                                      onChange={() => toggleCourt(c)}
                                                    />
                                                    {c}
                                                  </label>
                                                ))}
                                              </div>
                                            </div>

                                            <div className="mt-2 text-xs text-gray-500">
                                              Tip: leave everything unchecked to default to Supreme Court.
                                            </div>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  )}

                                  {/* Advanced Search Block (Statutes only) */}
                                  {searchDomain === 'statutes' && (
                                    <div className="border border-gray-300 rounded-lg p-4 mb-4">
                                      <button
                                        type="button"
                                        onClick={() => setShowAdvancedOption(prev => !prev)}
                                        className="w-full flex justify-between items-center text-left focus:outline-none"
                                      >
                                        <span className="font-medium text-gray-800">Advanced Search</span>
                                        <span className="text-gray-400">{showAdvancedOption ? '▲' : '▼'}</span>
                                      </button>

                                      {!showAdvancedOption && (
                                        <div className="mt-2 text-xs text-gray-500 flex flex-row flex-wrap gap-x-6 gap-y-1">
                                          {sectionTitle && <span>Search within Section Title: “{sectionTitle}”</span>}
                                          {selectedStatutes.length > 0 && (
                                            <span>
                                              Sources: {selectedStatutes.length > 3
                                                ? `${selectedStatutes.slice(0, 3).join(", ")} +${selectedStatutes.length - 3} more`
                                                : selectedStatutes.join(", ")}
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {showAdvancedOption && (
                                        <>
                                          <p className="text-sm text-gray-500 mt-3">
                                            “Search within Section Title” restricts matches to section titles of the selected sources.
                                          </p>

                                          <hr className="border-gray-300 my-4" />
                                          <div className="grid grid-cols-1 gap-6 mb-4">
                                            <div className="flex flex-col">
                                              <label className="text-sm font-medium text-gray-700 mb-1">
                                                Search within Section Title:
                                              </label>
                                              <input
                                                type="text"
                                                value={sectionTitle}
                                                onChange={(e) => setSectionTitle(e.target.value)}
                                                className="p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 placeholder-gray-300 text-gray-700"
                                                placeholder='Enter Section Title'
                                              />
                                            </div>
                                          </div>

                                          {/* Sources: Central Acts + States */}
                                          <hr className="border-gray-300 my-4" />
                                          <div className="mb-2">
                                            <label className="text-sm font-medium text-gray-700">Sources:</label>
                                            <p className="text-xs text-gray-500 mb-2">
                                              Select at least one source: “Central Acts” and/or one or more States.
                                            </p>

                                            <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                                              {/* Central Acts */}
                                              <div className="flex items-center">
                                                <input
                                                  id="central-acts"
                                                  type="checkbox"
                                                  className="mr-2"
                                                  checked={isStatuteChecked("Central Acts")}
                                                  onChange={() => toggleStatute("Central Acts")}
                                                />
                                                <label htmlFor="central-acts" className="text-sm text-gray-700">Central Acts</label>
                                              </div>

                                              {/* States */}
                                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-y-2">
                                                {loadingStates && statesList.length === 0 && (
                                                  <span className="text-xs text-gray-500 col-span-full">Loading states…</span>
                                                )}
                                                {!loadingStates && statesList.map((s) => (
                                                  <label key={s} className="inline-flex items-center text-sm text-gray-700">
                                                    <input
                                                      type="checkbox"
                                                      className="mr-2"
                                                      checked={isStatuteChecked(s)}
                                                      onChange={() => toggleStatute(s)}
                                                    />
                                                    {s}
                                                  </label>
                                                ))}
                                              </div>
                                            </div>

                                            <div className="mt-2 text-xs text-gray-500">
                                              Tip: leave everything unchecked to default to Central Acts.
                                            </div>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  )}

                                  <div className="mt-2 flex items-center justify-between gap-3">
                                    <button
                                      onClick={() => setShowClearConfirm(true)}
                                      disabled={isSearching}
                                      className={`py-3 px-6 rounded-lg font-medium border transition
${isSearching ? "bg-gray-200 text-gray-400 cursor-not-allowed border-gray-200"
                                          : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"}`}
                                      title="Clear all refine/advanced fields and selected courts/sources"
                                    >
                                      Clear
                                    </button>
                                    <button
                                      onClick={applyConfiguration}
                                      disabled={isSearching}
                                      className={`py-3 px-6 rounded-lg font-medium transition
${isSearching ? "bg-gray-400 cursor-not-allowed text-white" : "bg-gray-900 hover:bg-gray-800 text-white"}`}
                                      title="Apply refine keywords and advanced filters"
                                    >
                                      {isSearching ? (
                                        <span className="inline-flex items-center gap-2">
                                          <span className="inline-block h-4 w-4 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                                          Retrieving…
                                        </span>
                                      ) : (
                                        "Apply"
                                      )}
                                    </button>
                                  </div>

                                  {lastAppliedSummary && !isSearching && (
                                    <p className="mt-3 text-xs text-gray-600">
                                      Applied: {lastAppliedSummary}
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}
                            {isSearching && (
                              <div className="fixed inset-0 z-[60] flex items-center justify-center">
                                <div className="absolute inset-0 bg-black/10 backdrop-blur-sm" />
                                <div className="relative z-[61] flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl border border-gray-200 bg-white">
                                  <span className="inline-block h-5 w-5 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
                                  <span className="text-sm text-gray-700">Retrieving results…</span>
                                </div>
                              </div>
                            )}

                            {showDatePopup && (
                              <div className="fixed inset-0 z-[80]">
                                <div
                                  className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                                  onClick={toggleDatePopup}
                                />
                                <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
                                  <div className="pointer-events-auto bg-white p-6 rounded-2xl shadow-2xl border border-gray-200 w-[520px] max-w-[92vw]">
                                    <LocalizationProvider dateAdapter={AdapterDateFns}>
                                      <div className="flex justify-between items-start mb-4">
                                        <div>
                                          <h2 className="text-xl font-semibold text-gray-800 mb-1">Select Date Range</h2>
                                          <p className="text-sm text-gray-500">Filter judgments within a custom date range.</p>
                                        </div>
                                        <button
                                          onClick={toggleDatePopup}
                                          className="text-gray-400 hover:text-gray-700 transition text-2xl leading-none ml-4"
                                          title="Close"
                                        >
                                          &times;
                                        </button>
                                      </div>

                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                        <DatePicker
                                          label="Start Date"
                                          value={state[0].startDate}
                                          onChange={(date: Date | null) => {
                                            setState([{ ...state[0], startDate: date }]);
                                          }}
                                          slotProps={{ textField: { size: 'small', fullWidth: true } }}
                                        />
                                        <DatePicker
                                          label="End Date"
                                          value={state[0].endDate}
                                          minDate={state[0].startDate || undefined}
                                          onChange={(date: Date | null) => {
                                            setState([{ ...state[0], endDate: date }]);
                                          }}
                                          slotProps={{ textField: { size: 'small', fullWidth: true } }}
                                        />
                                      </div>

                                      <div className="flex justify-between items-center">
                                        <button
                                          onClick={() => {
                                            setState([{ startDate: null, endDate: null, key: 'selection' }]);
                                          }}
                                          className="text-sm text-gray-500 hover:underline"
                                        >
                                          Clear
                                        </button>
                                      </div>
                                    </LocalizationProvider>
                                  </div>
                                </div>
                              </div>
                            )}

                            {showScopeWarn && (
                              <div className="fixed inset-0 z-[70] flex items-center justify-center">
                                <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={cancelCourtChange} />
                                <div className="relative z-[71] bg-white rounded-2xl shadow-2xl border border-gray-200 w-[560px] max-w-[92vw] p-6">
                                  <h4 className="text-lg font-medium text-gray-900 mb-2">Changing courts may invalidate filters</h4>
                                  <p className="text-sm text-gray-700 mb-6">{scopeWarnText}</p>

                                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <button
                                      onClick={acceptCourtChangeClear}
                                      className="w-full px-3 py-2 rounded-md text-sm bg-gray-900 text-white hover:bg-gray-800"
                                    >
                                      Clear filters & keep new courts
                                    </button>
                                    <button
                                      onClick={acceptCourtChangeKeep}
                                      className="w-full px-3 py-2 rounded-md text-sm border border-gray-300 text-gray-800 hover:bg-gray-50"
                                    >
                                      Keep filters anyway
                                    </button>
                                    <button
                                      onClick={cancelCourtChange}
                                      className="w-full px-3 py-2 rounded-md text-sm text-gray-600 hover:text-gray-800"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                            {showStatutesScopeWarn && (
                              <div className="fixed inset-0 z-[85] grid place-items-center p-4 sm:p-6 lg:p-12">
                                <div
                                  className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                                  onClick={cancelStatutesChange}
                                />
                                <div className="relative bg-white backdrop-blur-lg rounded-2xl shadow-2xl p-6 w-[min(560px,92vw)]">
                                  <h3 className="text-xl font-medium text-gray-900 mb-2">
                                    Changing sources may invalidate filters
                                  </h3>
                                  <p className="text-sm text-gray-700 mb-5">
                                    {statutesScopeWarnText}
                                  </p>
                                  <div className="flex flex-col sm:flex-row gap-2 justify-end">
                                    <button
                                      onClick={cancelStatutesChange}
                                      className="px-4 py-2 rounded-lg border border-gray-300 text-gray-800 bg-white hover:bg-gray-50"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={acceptStatutesChangeKeep}
                                      className="px-4 py-2 rounded-lg border border-gray-300 text-gray-800 bg-white hover:bg-gray-50"
                                    >
                                      Switch & keep filters
                                    </button>
                                    <button
                                      onClick={acceptStatutesChangeClear}
                                      className="px-4 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800"
                                    >
                                      Switch & clear filters
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                            {showClearConfirm && (
                              <div className="fixed inset-0 z-[75] flex items-center justify-center">
                                <div
                                  className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                                  onClick={() => setShowClearConfirm(false)}
                                />
                                <div className="relative z-[76] bg-white rounded-2xl shadow-2xl border border-gray-200 w-[520px] max-w-[92vw] p-6">
                                  <h4 className="text-lg font-medium text-gray-900 mb-2">
                                    Clear all refine & advanced fields?
                                  </h4>
                                  <p className="text-sm text-gray-700 mb-6">
                                    You’re about to clear <strong>Refine Search</strong> keywords and <strong>Advanced Filters</strong>. This won’t delete your past search results or history.
                                  </p>

                                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <button
                                      onClick={() => {
                                        clearAllConfigFields();
                                        setShowClearConfirm(false);
                                      }}
                                      className="w-full px-3 py-2 rounded-md text-sm bg-gray-900 text-white hover:bg-gray-800"
                                    >
                                      Yes, clear everything
                                    </button>
                                    <button
                                      onClick={() => setShowClearConfirm(false)}
                                      className="w-full px-3 py-2 rounded-md text-sm border border-gray-300 text-gray-800 hover:bg-gray-50"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                            {enterpriseSettings &&
                              enterpriseSettings.custom_lower_disclaimer_content && (
                                <div className="mobile:hidden mt-4 flex items-center justify-center relative w-[95%] mx-auto">
                                  <div className="text-sm text-text-500 max-w-searchbar-max px-4 text-center">
                                    <MinimalMarkdown
                                      content={
                                        enterpriseSettings.custom_lower_disclaimer_content
                                      }
                                    />
                                  </div>
                                </div>
                              )}
                            {enterpriseSettings &&
                              enterpriseSettings.use_custom_logotype && (
                                <div className="hidden lg:block absolute right-0 bottom-0">
                                  <img
                                    src="/api/enterprise-settings/logotype"
                                    alt="logotype"
                                    style={{ objectFit: "contain" }}
                                    className="w-fit h-8"
                                  />
                                </div>
                              )}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{ transition: "width 0.30s ease-out" }}
                        className={`
                          flex-none 
                          overflow-y-hidden 
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${documentSidebarVisible && !settings?.isMobile
                            ? "w-[350px]"
                            : "w-[0px]"
                          }
                      `}
                      />
                    </div>
                  )}
                </Dropzone>
              ) : (
                <div className="mx-auto h-full flex">
                  <div
                    style={{ transition: "width 0.30s ease-out" }}
                    className={`flex-none bg-transparent transition-all bg-opacity-80 duration-300 ease-in-out h-full
                        ${sidebarVisible && !settings?.isMobile
                        ? "w-[250px] "
                        : "w-[0px]"
                      }`}
                  />
                  <div className="my-auto">
                    <OnyxInitializingLoader />
                  </div>
                </div>
              )}
            </div>
          </div>
          <FixedLogo backgroundToggled={sidebarVisible || showHistorySidebar} />
        </div>
      </div>
    </>
  );
}