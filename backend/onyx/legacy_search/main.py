from fastapi import APIRouter, Depends
from typing import List, Optional
from pydantic import BaseModel
import datetime as dt

from onyx.auth.users import current_user
from onyx.legacy_search.mongo_utils import (
    judgements_search,
    get_supported_hc_courts,
    build_highlight_snippets,
    get_supported_states,
    statutes_search,
)

router = APIRouter(prefix="/legacysearch", tags=["Legacy Search"])

# ========= Models =========

class JudgementsSearchRequest(BaseModel):
    query: str
    courts: List[str]                          # e.g. ["Supreme Court","Bombay High Court"]
    judge_name: Optional[str] = None
    case_title: Optional[str] = None
    start_date: Optional[dt.date] = None
    end_date: Optional[dt.date] = None
    page: int = 1
    page_size: int = 20

class JudgementsSearchResponse(BaseModel):
    results: List[dict]
    total: int
    page: int
    page_size: int
    has_more: bool
    sc_total: Optional[int] = None
    hc_total: Optional[int] = None
    
# ========= New Models (Refine & Advanced) =========

class RefineRequest(BaseModel):
    results: List[dict]                 # the current page you already rendered
    keywords: List[str]                 # terms to highlight
    max_snippets_per_doc: int = 3
    snippet_window: int = 120           # chars around each match

class RefineResponseDoc(BaseModel):
    source: Optional[str] = None
    collection: Optional[str] = None
    file_name: Optional[str] = None
    title: Optional[str] = None
    match_count: int
    snippets: List[str]                 # HTML with <mark>…</mark>

class RefineResponse(BaseModel):
    docs: List[RefineResponseDoc]

class AdvancedSearchRequest(BaseModel):
    # same shape as JudgementsSearchRequest (separate name for clarity)
    query: str
    courts: List[str]
    judge_name: Optional[str] = None
    case_title: Optional[str] = None
    start_date: Optional[dt.date] = None
    end_date: Optional[dt.date] = None
    page: int = 1
    page_size: int = 20
    
# ========= Statutes Models (NEW) =========

class StatutesSearchRequest(BaseModel):
    # General text search across statute name/title/text
    query: str = ""
    # Selection: ["Central Acts"] and/or one or more state names (e.g., ["Assam","West Bengal"])
    statutes: List[str]
    page: int = 1
    page_size: int = 20

class StatutesAdvancedSearchRequest(StatutesSearchRequest):
    # "Search within Section Title" only (when provided)
    section_title: Optional[str] = None

class StatutesSearchResponse(BaseModel):
    results: List[dict]
    total: int
    page: int
    page_size: int
    has_more: bool
    central_total: Optional[int] = None
    state_total: Optional[int] = None

# ========= Endpoints (Judgements) =========

@router.get("/judgements/courts")
def courts(user=Depends(current_user)):
    """
    Returns the selectable list for the UI:
      - "Supreme Court"
      - High Courts present in hc_cases
    """
    return {
        "supreme": "Supreme Court",
        "high_courts": get_supported_hc_courts(),
    }

@router.post("/judgements/search", response_model=JudgementsSearchResponse)
def judgements(request: JudgementsSearchRequest, user=Depends(current_user)):
    """
    Behavior:
      - If only 'Supreme Court' is selected: returns SC raw fields
      - If only High Courts are selected: returns HC raw fields
      - If both are selected: returns unified shape for mixing/pagination
      - If nothing is selected: defaults to Supreme Court (SC raw fields)
    """
    data = judgements_search(
        query=request.query,
        courts=request.courts,
        judge_name=request.judge_name,
        case_title=request.case_title,
        start_date=request.start_date,
        end_date=request.end_date,
        page=request.page,
        page_size=request.page_size,
    )
    return data

@router.post("/judgements/refine", response_model=RefineResponse)
def refine(req: RefineRequest, user=Depends(current_user)):
    """
    Refine = highlight on already-returned results (no DB query).
    """

    refined_docs = []
    for doc in req.results:
        refined_docs.append(
            build_highlight_snippets(
                doc=doc,
                keywords=req.keywords,
                max_snippets=req.max_snippets_per_doc,
                window=req.snippet_window,
            )
        )
    return {"docs": refined_docs}


@router.post("/judgements/advanced", response_model=JudgementsSearchResponse)
def advanced(request: AdvancedSearchRequest, user=Depends(current_user)):
    """
    Advanced search = same engine as /judgements/search, separate route for the UI's Advanced panel.
    """
    data = judgements_search(
        query=request.query,
        courts=request.courts,
        judge_name=request.judge_name,
        case_title=request.case_title,
        start_date=request.start_date,
        end_date=request.end_date,
        page=request.page,
        page_size=request.page_size,
    )
    return data

# ========= Endpoints (Statutes) — NEW =========

@router.get("/statutes/states")
def statutes_states(user=Depends(current_user)):
    """
    Returns the selectable list for Statutes UI:
      - "Central Acts"
      - State names present in state_acts (normalized, deduped, sorted)
    """
    return {
        "central": "Central Acts",
        "states": get_supported_states(),
    }

@router.post("/statutes/search", response_model=StatutesSearchResponse)
def statutes_basic(request: StatutesSearchRequest, user=Depends(current_user)):
    """
    Basic Statutes search across selected sources (Central, State(s), or both).
    If 'statutes' is empty, defaults to Central Acts (same UX as Judgements default to SC).
    """
    data = statutes_search(
        query=request.query,
        statutes=request.statutes,
        section_title=None,           # not restricting to Section Title here
        page=request.page,
        page_size=request.page_size,
    )
    return data

@router.post("/statutes/advanced", response_model=StatutesSearchResponse)
def statutes_advanced(request: StatutesAdvancedSearchRequest, user=Depends(current_user)):
    """
    Advanced Statutes search: only 'section_title' is considered as an extra filter.
    (No dates, judge, or case title here.)
    """
    data = statutes_search(
        query=request.query,
        statutes=request.statutes,
        section_title=request.section_title,   # restrict to Section Title if provided
        page=request.page,
        page_size=request.page_size,
    )
    return data

@router.post("/statutes/refine", response_model=RefineResponse)
def statutes_refine(req: RefineRequest, user=Depends(current_user)):
    """
    Refine = highlight on already-returned Statutes results (no DB query).
    """

    refined_docs = []
    for doc in req.results:
        refined_docs.append(
            build_highlight_snippets(
                doc=doc,
                keywords=req.keywords,
                max_snippets=req.max_snippets_per_doc,
                window=req.snippet_window,
            )
        )
    return {"docs": refined_docs}
