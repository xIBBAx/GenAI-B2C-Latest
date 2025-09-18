import os
import re
import html
import datetime as dt
from typing import Any, Dict, List, Optional

import pymongo  # type: ignore
from dotenv import load_dotenv  # type: ignore

load_dotenv()

# ========= Mongo connection (nyayamind DB) =========
def _mongo():
    url = os.environ.get("CONNECTION_URL")
    if not url:
        raise RuntimeError("CONNECTION_URL env var is missing")
    client = pymongo.MongoClient(url)
    return client["nyayamind"]

DB = _mongo()
SC = "sc_cases"
HC = "hc_cases"
CA = "central_acts"
SA = "state_acts"

# ========= Date parsing =========
DATE_FORMATS = [
    "%Y-%m-%d",
    "%d %B, %Y",
    "%d %B %Y",
    "%d %b, %Y",
    "%d-%m-%Y",
    "%d/%m/%Y",
]

def _parse_date_safe(s: Optional[str]) -> Optional[dt.date]:
    if not s:
        return None
    s = str(s).strip()
    for fmt in DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, fmt).date()
        except Exception:
            continue
    try:
        # ISO yyyy-mm-dd…
        return dt.date.fromisoformat(s[:10])
    except Exception:
        return None

# ========= Court list (dynamic; exact values present in hc_cases) =========
_FALLBACK_HC_LABELS = [
    "Allahabad High Court",
    "Bombay High Court",
    "Calcutta High Court",
    "Gauhati High Court",
    "High Court for the State of Telangana",
    "High Court of Andhra Pradesh",
    "High Court of Chhattisgarh",
    "High Court of Delhi",
    "High Court of Gujarat",
    "High Court of Himachal Pradesh",
    "High Court of Jammu and Kashmir",
    "High Court of Jharkhand",
    "High Court of Karnataka",
    "High Court of Kerala",
    "High Court of Madhya Pradesh",
    "High Court of Manipur",
    "High Court of Meghalaya",
    "High Court of Orissa",
    "High Court of Punjab and Haryana",
    "High Court of Rajasthan",
    "High Court of Sikkim",
    "High Court of Tripura",
    "High Court of Uttarakhand",
    "Madras High Court",
    "Patna High Court",
]

def get_supported_hc_courts() -> List[str]:
    try:
        vals = DB[HC].distinct("Court Name")
        vals = [v for v in vals if isinstance(v, str) and v.strip()]
        if vals:
            vals.sort(key=lambda x: x.lower())
            return vals
    except Exception:
        pass
    return _FALLBACK_HC_LABELS

# ========= States list (dynamic; exact values present in state_acts) =========

_STATE_SUFFIX_RX = re.compile(r"_[0-9]+$")

def _normalize_state_label(s: str) -> str:
    if not s:
        return ""
    s = s.strip()
    s = _STATE_SUFFIX_RX.sub("", s)  # drop trailing _\d (e.g., Rajasthan_3 -> Rajasthan)
    return s

def get_supported_states() -> List[str]:
    """
    Returns normalized, deduped, sorted state names from state_acts.
    Fallback list is provided if DB distinct fails.
    """
    try:
        vals = DB[SA].distinct("State Name")
        out = set()
        for v in vals or []:
            if isinstance(v, str) and v.strip():
                out.add(_normalize_state_label(v))
        if out:
            return sorted(out, key=lambda x: x.lower())
    except Exception:
        pass
    return [
        "Andaman and Nicobar Islands","Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chandigarh",
        "Chhattisgarh","Dadra and Nagar Haveli and Daman and Diu","Delhi","Goa","Gujarat","Haryana",
        "Himachal Pradesh","Jammu and Kashmir","Jharkhand","Karnataka","Kerala","Ladakh","Lakshadweep",
        "Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Odisha","Puducherry","Punjab","Rajasthan",
        "Tamil Nadu","Tripura","Uttar Pradesh","Uttarakhand","West Bengal",
    ]

# ========= Text search condition =========
def _text_condition(query: str) -> Dict[str, Any]:
    """
    Case/variant-tolerant text condition that works for both SC and HC docs.
    """
    q = (query or "").strip()
    if not q:
        return {}
    rx = {"$regex": re.escape(q), "$options": "i"}

    # cover common variants across SC/HC
    return {
        "$or": [
            {"all_text": rx},
            {"content": rx},

            # text fields (hc often has "Text")
            {"text": rx},
            {"Text": rx},

            # title fields (hc often has "Title"/"case title")
            {"title": rx},
            {"Title": rx},
            {"case title": rx},

            # file name variants
            {"file_name": rx},
            {"file name": rx},
        ]
    }
    
# ========= Statutes: text search condition (name/title/text) =========
def _text_condition_statutes(query: str) -> Dict[str, Any]:
    q = (query or "").strip()
    if not q:
        return {}
    rx = {"$regex": re.escape(q), "$options": "i"}
    return {
        "$or": [
            {"Section Text": rx},
            {"Section Title": rx},
            {"Name of statute": rx},
            {"Name of Statute": rx},
        ]
    }
    
def _title_regex_from_user(title: str) -> Optional[Dict[str, Any]]:
    """
    Turn a user-entered case title into a tolerant regex that:
      - collapses punctuation/spacing differences
      - normalizes 'v' / 'v.' / 'vs' / 'vs.' to the same token
      - matches across Title/case title/file_name fields
    """
    if not title:
        return None
    s = str(title).strip()
    if not s:
        return None

    # Normalize Vs variants to a single token 'v'
    s = re.sub(r"\bV(?:S\.?)?\b", " v ", s, flags=re.IGNORECASE)

    # Extract only alphanumeric or & tokens (ignore commas, dots, etc.)
    tokens = re.findall(r"[A-Za-z0-9&]+", s)
    if not tokens:
        return None

    parts = []
    for t in tokens:
        if t.lower() == "v":
            parts.append(r"(?:v|vs\.?)")  # accept v / vs / vs.
        else:
            parts.append(re.escape(t))

    # Allow any punctuation/spaces between tokens
    pattern = r"\b" + r"\W+".join(parts) + r"\b"
    return {"$regex": pattern, "$options": "i"}

# ========= Normalizers =========
# Raw outputs (exact field names you asked for)
def _norm_sc_raw(doc: Dict[str, Any]) -> Dict[str, Any]:
    file_name = doc.get("file_name") or doc.get("title") or ""
    case_no = doc.get("case_no") or None
    citation = doc.get("citation") or None
    bench = doc.get("bench") or None
    judgement_by = doc.get("judgement_by") or bench

    # pick a date string from available SC fields
    raw_date = doc.get("judgment_dates") or doc.get("date_of_judgment") or doc.get("doc_date") or ""
    if isinstance(raw_date, list) and raw_date:
        raw_date = raw_date[0]

    sort_date = _parse_date_safe(raw_date)  # -> dt.date or None
    content = doc.get("content") or doc.get("all_text") or ""

    return {
        "file_name": file_name,
        "case_no": case_no,
        "citation": citation,
        "bench": bench,
        "judgement_by": judgement_by,
        "content": content,

        # NEW: expose a normalized date for UI use (ISO yyyy-mm-dd)
        "judgment_dates": sort_date.isoformat() if sort_date else None,

        "source": "SC",
        "collection": SC,
        "_sort_date": sort_date.isoformat() if sort_date else None,
    }

def _norm_hc_raw(doc: Dict[str, Any]) -> Dict[str, Any]:
    court_name = (doc.get("Court Name") or doc.get("Court name") or "").strip()
    title = doc.get("title") or doc.get("Title") or doc.get("case title") or ""
    case_number = doc.get("case number") or doc.get("Case Number") or None
    cnr = doc.get("CNR") or doc.get("cnr") or None
    judge = doc.get("judge") or doc.get("Judge") or None
    decision_date = doc.get("decision date") or doc.get("Decision Date") or ""
    disposal_nature = doc.get("disposal nature") or doc.get("Disposal Nature") or None
    text = doc.get("text") or doc.get("Text") or doc.get("all_text") or ""

    sort_date = _parse_date_safe(decision_date)

    return {
        "Court name": court_name,
        "title": title,
        "case number": case_number,
        "cnr": cnr,
        "decision date": decision_date if decision_date else None,
        "disposal nature": disposal_nature,
        "judge": judge,
        "text": text,
        "source": "HC",
        "collection": HC,
        "_sort_date": sort_date.isoformat() if sort_date else None,
    }

# Unified outputs (used only when both SC & HC are selected)
def _norm_sc_merged(doc: Dict[str, Any]) -> Dict[str, Any]:
    file_name = doc.get("file_name") or doc.get("title") or ""
    case_no = doc.get("case_no") or None
    citation = doc.get("citation") or None
    bench = doc.get("bench") or None
    judgement_by = doc.get("judgement_by") or bench
    content = doc.get("content") or doc.get("all_text") or ""

    jd = doc.get("judgment_dates") or doc.get("date_of_judgment") or doc.get("doc_date") or ""
    if isinstance(jd, list) and jd:
        jd = jd[0]
    sort_date = _parse_date_safe(jd)

    return {
        "file_name": file_name,
        "case_no": case_no,
        "citation": citation,
        "bench": bench,
        "judgement_by": judgement_by,
        "content": content,

        # HC fields (empty for SC rows)
        "Court name": None,
        "title": None,
        "case number": None,
        "cnr": None,
        "decision date": None,
        "disposal nature": None,
        "judge": None,
        "text": None,

        # NEW: normalized SC date for UI
        "judgment_dates": sort_date.isoformat() if sort_date else None,

        "source": "SC",
        "collection": SC,
        "_sort_date": sort_date.isoformat() if sort_date else None,
    }

def _norm_hc_merged(doc: Dict[str, Any]) -> Dict[str, Any]:
    # HC raw fields (handle variants)
    court_name = (doc.get("Court Name") or doc.get("Court name") or "").strip()
    title = doc.get("title") or doc.get("Title") or doc.get("case title") or ""
    case_number = doc.get("case number") or doc.get("Case Number") or None
    cnr = doc.get("CNR") or doc.get("cnr") or None
    judge = doc.get("judge") or doc.get("Judge") or None
    decision_date = doc.get("decision date") or doc.get("Decision Date") or None
    disposal_nature = doc.get("disposal nature") or doc.get("Disposal Nature") or None
    text = doc.get("text") or doc.get("Text") or doc.get("all_text") or ""

    sort_date = _parse_date_safe(decision_date) if decision_date else None

    # Return exactly the requested merged schema + context
    return {
        # SC fields present but empty for HC rows
        "file_name": None,
        "case_no": None,
        "citation": None,
        "bench": None,
        "judgement_by": None,
        "content": None,

        # HC fields
        "Court name": court_name,
        "title": title,
        "case number": case_number,
        "cnr": cnr,
        "decision date": decision_date,
        "disposal nature": disposal_nature,
        "judge": judge,
        "text": text,

        # context
        "source": "HC",
        "collection": HC,

        # internal (not returned after pagination step)
        "_sort_date": sort_date.isoformat() if sort_date else None,
    }
    
# ========= Statutes: normalizers =========

def _norm_central_raw(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name of statute": doc.get("Name of statute") or doc.get("Name of Statute") or "",
        "section number": doc.get("Section Number") or "",
        "section title":  doc.get("Section Title") or "",
        "section text":   doc.get("Section Text") or "",
        "source": "CENTRAL",
        "collection": CA,
    }

def _norm_state_raw(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "state name":      _normalize_state_label(doc.get("State Name") or ""),
        "name of statute": doc.get("Name of statute") or doc.get("Name of Statute") or "",
        "section number":  doc.get("Section Number") or "",
        "section title":   doc.get("Section Title") or "",
        "section text":    doc.get("Section Text") or "",
        "source": "STATE",
        "collection": SA,
    }

def _norm_central_merged(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "state name": None,
        "name of statute": doc.get("Name of statute") or doc.get("Name of Statute") or "",
        "section number":  doc.get("Section Number") or "",
        "section title":   doc.get("Section Title") or "",
        "section text":    doc.get("Section Text") or "",
        "source": "CENTRAL",
        "collection": CA,
    }

def _norm_state_merged(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "state name":      _normalize_state_label(doc.get("State Name") or ""),
        "name of statute": doc.get("Name of statute") or doc.get("Name of Statute") or "",
        "section number":  doc.get("Section Number") or "",
        "section title":   doc.get("Section Title") or "",
        "section text":    doc.get("Section Text") or "",
        "source": "STATE",
        "collection": SA,
    }

def _between_dates_expr(field_path: str, fmt: str, start: dt.date, end: dt.date, array_first: bool = False):
    """
    Build a $expr that parses a string/array-of-strings date field and checks start <= field <= end.
    Robust to both scalar strings and arrays; array_first flag is ignored (kept for backward-compat).
    """
    # if field is an array, pick the first element; else use the field directly
    src = {
        "$cond": [
            {"$isArray": f"${field_path}"},
            {"$arrayElemAt": [f"${field_path}", 0]},
            f"${field_path}",
        ]
    }

    parsed = {
        "$dateFromString": {
            "dateString": src,
            "format": fmt,
            "onError": None,
            "onNull": None,
        }
    }

    # parse ISO bounds once (Mongo can parse yyyy-mm-dd without an explicit format)
    start_iso = {"$dateFromString": {"dateString": start.isoformat()}}
    end_iso   = {"$dateFromString": {"dateString": end.isoformat()}}

    return {
        "$and": [
            {"$gte": [parsed, start_iso]},
            {"$lte": [parsed, end_iso]},
        ]
    }
    
def _hc_label_variants(label: str) -> List[str]:
    """
    Return common synonyms so 'High Court of X' also matches 'X High Court', etc.
    Matching will be case-insensitive (via regex).
    """
    s = (label or "").strip()
    out = {s}
    m = re.match(r"^High Court (?:of|for the State of)\s+(.+)$", s, flags=re.I)
    if m:
        out.add(f"{m.group(1)} High Court")
    m2 = re.match(r"^(.+?)\s+High Court$", s, flags=re.I)
    if m2:
        out.add(f"High Court of {m2.group(1)}")
    return list(out)

_HONORIFICS_RX = re.compile(
    r"\b(hon'?ble|honou?rable|the|chief|justice|judge|cj|jjs?|mr|mrs|ms|dr|shri|smt|sir|lady|lord)\b",
    re.IGNORECASE,
)

def _hc_tokenize_name(s: str) -> List[str]:
    """
    Normalize a judge name to tokens:
      'HON'BLE SHRI JUSTICE M. S. SONAK' -> ['m','s','sonak']
    """
    if not s:
        return []
    s = s.strip()
    s = _HONORIFICS_RX.sub(" ", s)          # drop honorifics/roles
    s = re.sub(r"[^\w\s]", " ", s)          # drop punctuation
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return []
    toks = s.lower().split(" ")
    return [t for t in toks if t]

def _hc_name_pattern_from_tokens(tokens: List[str]) -> str:
    """
    Build a spacing/punctuation tolerant regex that matches tokens in order.
    Initials may appear as 'M' or 'M.':
      ['m','s','sonak'] -> r'(?i)\bm\.?\s*s\.?\s*sonak\b'
    Return pattern string (Mongo supports inline (?i)).
    """
    if not tokens:
        return r"$a"  # never matches
    parts: List[str] = []
    for i, t in enumerate(tokens):
        if len(t) == 1:
            parts.append(re.escape(t) + r"\.?\s*")  # tolerate "M" / "M."
        else:
            parts.append(re.escape(t))
        if i < len(tokens) - 1:
            parts.append(r"\s*")
    return r"(?i)\b" + "".join(parts) + r"\b"

def _hc_judge_filter_from_input(judge_input: str) -> Optional[Dict[str, Any]]:
    """
    Convert a user input (possibly comma-separated list of judges) into a Mongo
    filter tolerant to honorifics, punctuation, and spacing *and* matching both
    'judge' and 'Judge' fields as stored in hc_cases.

    Example:
      "HON'BLE ... M. S. SONAK,HON'BLE ... VALMIKI MENEZES"
      -> {"$or": [{"judge":{"$regex":...}}, {"Judge":{"$regex":...}}, ...]}
    """
    if not judge_input or not judge_input.strip():
        return None

    names = [n.strip() for n in judge_input.split(",") if n.strip()]
    if not names:
        return None

    or_clauses: List[Dict[str, Any]] = []
    for name in names:
        toks = _hc_tokenize_name(name)
        if not toks:
            continue
        pat = _hc_name_pattern_from_tokens(toks)
        or_clauses.append({"judge": {"$regex": pat}})
        or_clauses.append({"Judge": {"$regex": pat}})
    if not or_clauses:
        return None
    return {"$or": or_clauses}

# ======== Server-side sort helpers (dates parsed inside Mongo) ========

def _first_string_expr(field_path: str):
    # If field is an array, take first element; else use the field
    return {
        "$cond": [
            {"$isArray": f"${field_path}"},
            {"$arrayElemAt": [f"${field_path}", 0]},
            f"${field_path}",
        ]
    }

def _coalesce_expr(exprs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return first non-null from a list of expressions."""
    if not exprs:
        return None  # type: ignore
    out = exprs[0]
    for e in exprs[1:]:
        out = {"$ifNull": [out, e]}
    return out

def _sc_sort_date_expr():
    jd_first = _first_string_expr("judgment_dates")
    return _coalesce_expr([
        {"$dateFromString": {"dateString": jd_first,             "format": "%Y-%m-%d", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": jd_first,             "format": "%d-%m-%Y", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$date_of_judgment",  "format": "%Y-%m-%d", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$date_of_judgment",  "format": "%d-%m-%Y", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$doc_date",          "format": "%Y-%m-%d", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$doc_date",          "format": "%d-%m-%Y", "onError": None, "onNull": None}},
    ])

def _hc_sort_date_expr():
    return _coalesce_expr([
        {"$dateFromString": {"dateString": "$decision date",     "format": "%Y-%m-%d", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$decision date",     "format": "%d-%m-%Y", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$Decision Date",     "format": "%Y-%m-%d", "onError": None, "onNull": None}},
        {"$dateFromString": {"dateString": "$Decision Date",     "format": "%d-%m-%Y", "onError": None, "onNull": None}},
    ])

# ======== Reuse your existing condition builders, but as functions ========

def _build_sc_match(
    query: str,
    judge_name: Optional[str],
    case_title: Optional[str],
    start_date: Optional[dt.date],
    end_date: Optional[dt.date],
) -> Dict[str, Any]:
    cond: Dict[str, Any] = {}
    tc = _text_condition(query)
    if tc:
        cond.update(tc)
    if judge_name:
        rx = {"$regex": re.escape(judge_name), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"judgement_by": rx}, {"bench": rx}]})
    if case_title:
        rx = _title_regex_from_user(case_title) or {"$regex": re.escape(case_title), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"file_name": rx}, {"title": rx}]})
    if start_date and end_date:
        cond.setdefault("$and", []).append({
            "$or": [
                {"$expr": _between_dates_expr("judgment_dates",   "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("judgment_dates",   "%Y-%m-%d", start_date, end_date)},
                {"$expr": _between_dates_expr("date_of_judgment", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("date_of_judgment", "%Y-%m-%d", start_date, end_date)},
                {"$expr": _between_dates_expr("doc_date",         "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("doc_date",         "%Y-%m-%d", start_date, end_date)},
            ]
        })
    return cond

def _build_hc_match(
    query: str,
    selected_hc: List[str],
    judge_name: Optional[str],
    case_title: Optional[str],
    start_date: Optional[dt.date],
    end_date: Optional[dt.date],
) -> Dict[str, Any]:
    cond: Dict[str, Any] = {}
    tc = _text_condition(query)
    if tc:
        cond.update(tc)
    if selected_hc:
        field_ors = []
        for lbl in selected_hc:
            variants = _hc_label_variants(lbl)
            regs = [{"$regex": f"^{re.escape(v)}$", "$options": "i"} for v in variants]
            for r in regs:
                field_ors.append({"Court Name": r})
                field_ors.append({"Court name": r})
        cond.setdefault("$and", []).append({"$or": field_ors})
    if judge_name:
        jf = _hc_judge_filter_from_input(judge_name)
        if jf:
            cond.setdefault("$and", []).append(jf)
    if case_title:
        rx = _title_regex_from_user(case_title) or {"$regex": re.escape(case_title), "$options": "i"}
        cond.setdefault("$and", []).append({
            "$or": [{"title": rx}, {"Title": rx}, {"case title": rx}, {"file_name": rx}, {"file name": rx}]
        })
    if start_date and end_date:
        cond.setdefault("$and", []).append({
            "$or": [
                {"$expr": _between_dates_expr("decision date", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("Decision Date", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("decision date", "%Y-%m-%d", start_date, end_date)},
                {"$expr": _between_dates_expr("Decision Date", "%Y-%m-%d", start_date, end_date)},
            ]
        })
    return cond

# ========= Statutes: condition builders =========

def _build_central_match(
    query: str,
    section_title: Optional[str],
) -> Dict[str, Any]:
    cond: Dict[str, Any] = {}
    if section_title and section_title.strip():
        # Advanced: restrict to Section Title only
        rx = {"$regex": re.escape(section_title.strip()), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"Section Title": rx}]})
    else:
        # Basic: general text condition
        tc = _text_condition_statutes(query)
        if tc:
            cond.update(tc)
    return cond

def _build_state_match(
    query: str,
    selected_states: List[str],
    section_title: Optional[str],
) -> Dict[str, Any]:
    cond: Dict[str, Any] = {}

    # restrict to selected states (case-insensitive; accept suffix variants in DB)
    if selected_states:
        or_states = []
        for s in selected_states:
            canon = _normalize_state_label(s)
            or_states.append({"State Name": {"$regex": f"^{re.escape(canon)}$", "$options": "i"}})
            or_states.append({"State Name": {"$regex": f"^{re.escape(canon)}(_[0-9]+)?$", "$options": "i"}})
        cond.setdefault("$and", []).append({"$or": or_states})

    if section_title and section_title.strip():
        rx = {"$regex": re.escape(section_title.strip()), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"Section Title": rx}]})
    else:
        tc = _text_condition_statutes(query)
        if tc:
            cond.update(tc)

    return cond

# ========= Per-collection queries (return RAW docs) =========
def _search_sc(
    query: str,
    judge_name: Optional[str],
    case_title: Optional[str],
    start_date: Optional[dt.date],
    end_date: Optional[dt.date],
) -> List[Dict[str, Any]]:
    cond: Dict[str, Any] = {}
    tc = _text_condition(query)
    if tc:
        cond.update(tc)

    if judge_name:
        rx = {"$regex": re.escape(judge_name), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"judgement_by": rx}, {"bench": rx}]})

    if case_title:
        rx = _title_regex_from_user(case_title) or {"$regex": re.escape(case_title), "$options": "i"}
        cond.setdefault("$and", []).append({"$or": [{"file_name": rx}, {"title": rx}]})

    if start_date and end_date:
        cond.setdefault("$and", []).append({
            "$or": [
                {"$expr": _between_dates_expr("judgment_dates", "%d-%m-%Y", start_date, end_date, array_first=True)},
                {"$expr": _between_dates_expr("judgment_dates", "%Y-%m-%d", start_date, end_date, array_first=True)},
                {"$expr": _between_dates_expr("date_of_judgment", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("date_of_judgment", "%Y-%m-%d", start_date, end_date)},
                {"$expr": _between_dates_expr("doc_date", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("doc_date", "%Y-%m-%d", start_date, end_date)},
            ]
        })

    proj = {
        "file_name": 1, "title": 1, "case_no": 1, "citation": 1,
        "bench": 1, "judgement_by": 1,
        "content": 1, "all_text": 1,
        "judgment_dates": 1, "date_of_judgment": 1, "doc_date": 1,
    }

    docs = list(DB[SC].find(cond, proj).limit(1000))
    return docs

def _search_hc(
    query: str,
    selected_hc: List[str],
    judge_name: Optional[str],
    case_title: Optional[str],
    start_date: Optional[dt.date],
    end_date: Optional[dt.date],
) -> List[Dict[str, Any]]:
    cond: Dict[str, Any] = {}
    tc = _text_condition(query)
    if tc:
        cond.update(tc)

    if selected_hc:
        # case-insensitive, exact match against several common variants
        field_ors = []
        for lbl in selected_hc:
            variants = _hc_label_variants(lbl)
            regs = [{"$regex": f"^{re.escape(v)}$", "$options": "i"} for v in variants]
            for r in regs:
                field_ors.append({"Court Name": r})
                field_ors.append({"Court name": r})
        cond.setdefault("$and", []).append({"$or": field_ors})

    if judge_name:
        jf = _hc_judge_filter_from_input(judge_name)
        if jf:
            cond.setdefault("$and", []).append(jf)

    if case_title:
        rx = _title_regex_from_user(case_title) or {"$regex": re.escape(case_title), "$options": "i"}
        cond.setdefault("$and", []).append({
            "$or": [
                {"title": rx},
                {"Title": rx},
                {"case title": rx},
                {"file_name": rx},
                {"file name": rx},
            ]
        })

    if start_date and end_date:
        cond.setdefault("$and", []).append({
            "$or": [
                {"$expr": _between_dates_expr("decision date", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("Decision Date", "%d-%m-%Y", start_date, end_date)},
                {"$expr": _between_dates_expr("decision date", "%Y-%m-%d", start_date, end_date)},
                {"$expr": _between_dates_expr("Decision Date", "%Y-%m-%d", start_date, end_date)},
            ]
        })

    proj = {
        # court name variants
        "Court Name": 1, "Court name": 1,

        # title variants (your sample uses "Title")
        "title": 1, "Title": 1, "case title": 1,

        # case number variants (your sample uses "Case Number")
        "case number": 1, "Case Number": 1,

        # CNR variants
        "CNR": 1, "cnr": 1,

        # date variants (your sample uses "Decision Date")
        "decision date": 1, "Decision Date": 1,

        # disposal nature variants (your sample uses "Disposal Nature")
        "disposal nature": 1, "Disposal Nature": 1,

        # judge variants (your sample uses "Judge")
        "judge": 1, "Judge": 1,

        # text variants (your sample uses "Text")
        "text": 1, "Text": 1, "all_text": 1,
    }

    docs = list(DB[HC].find(cond, proj).limit(1000))
    return docs

# ========= Unified Judgements search =========
def judgements_search(
    query: str,
    courts: List[str],
    judge_name: Optional[str],
    case_title: Optional[str],
    start_date: Optional[dt.date],
    end_date: Optional[dt.date],
    page: int,
    page_size: int,
) -> Dict[str, Any]:
    selected_hc: List[str] = []
    include_sc = False
    for c in (courts or []):
        if c.strip().lower() == "supreme court":
            include_sc = True
        else:
            selected_hc.append(c)
    if not include_sc and not selected_hc:
        include_sc = True

    mode = "both" if (include_sc and selected_hc) else ("sc" if include_sc else "hc")
    start = max(0, (page - 1) * page_size)

    # Build match conditions once
    sc_match = _build_sc_match(query, judge_name, case_title, start_date, end_date) if include_sc else None
    hc_match = _build_hc_match(query, selected_hc, judge_name, case_title, start_date, end_date) if selected_hc else None

    # Accurate totals (no artificial cap)
    sc_total_raw = DB[SC].count_documents(sc_match) if sc_match else 0
    hc_total_raw = DB[HC].count_documents(hc_match) if hc_match else 0

    # Aggregated, server-side sorted + paged results
    results: List[Dict[str, Any]] = []

    if mode == "sc":
        pipeline = [
            {"$match": sc_match or {}},
            {"$addFields": {"_sort_date": _sc_sort_date_expr()}},
            {"$sort": {"_sort_date": -1, "_id": -1}},
            {"$skip": start},
            {"$limit": page_size},
            {"$project": {
                "file_name": 1, "title": 1, "case_no": 1, "citation": 1,
                "bench": 1, "judgement_by": 1,
                "content": 1, "all_text": 1,
                "judgment_dates": 1, "date_of_judgment": 1, "doc_date": 1,
            }},
        ]
        docs = list(DB[SC].aggregate(pipeline))
        results = [_norm_sc_raw(d) for d in docs]

    elif mode == "hc":
        pipeline = [
            {"$match": hc_match or {}},
            {"$addFields": {"_sort_date": _hc_sort_date_expr()}},
            {"$sort": {"_sort_date": -1, "_id": -1}},
            {"$skip": start},
            {"$limit": page_size},
            {"$project": {
                "Court Name": 1, "Court name": 1,
                "title": 1, "Title": 1, "case title": 1,
                "case number": 1, "Case Number": 1,
                "CNR": 1, "cnr": 1,
                "decision date": 1, "Decision Date": 1,
                "disposal nature": 1, "Disposal Nature": 1,
                "judge": 1, "Judge": 1,
                "text": 1, "Text": 1, "all_text": 1,
            }},
        ]
        docs = list(DB[HC].aggregate(pipeline))
        results = [_norm_hc_raw(d) for d in docs]

    else:  # mode == "both" (SC + HC) → merged stream, sorted once, then paged
        sc_branch = [
            {"$match": sc_match or {}},
            {"$addFields": {"_sort_date": _sc_sort_date_expr()}},
            {"$project": {
                # pass through fields needed by _norm_sc_merged
                "file_name": 1, "title": 1, "case_no": 1, "citation": 1,
                "bench": 1, "judgement_by": 1,
                "content": 1, "all_text": 1,
                "judgment_dates": 1, "date_of_judgment": 1, "doc_date": 1,
                "source": {"$literal": "SC"}, "collection": {"$literal": SC},
                "_sort_date": 1,
            }},
        ]
        hc_branch = [
            {"$match": hc_match or {}},
            {"$addFields": {"_sort_date": _hc_sort_date_expr()}},
            {"$project": {
                # pass through fields needed by _norm_hc_merged
                "Court Name": 1, "Court name": 1,
                "title": 1, "Title": 1, "case title": 1,
                "case number": 1, "Case Number": 1,
                "CNR": 1, "cnr": 1,
                "decision date": 1, "Decision Date": 1,
                "disposal nature": 1, "Disposal Nature": 1,
                "judge": 1, "Judge": 1,
                "text": 1, "Text": 1, "all_text": 1,
                "source": {"$literal": "HC"}, "collection": {"$literal": HC},
                "_sort_date": 1,
            }},
        ]

        pipeline = sc_branch + [
            {"$unionWith": {"coll": HC, "pipeline": hc_branch}},
            {"$sort": {"_sort_date": -1, "_id": -1}},
            {"$skip": start},
            {"$limit": page_size},
        ]
        docs = list(DB[SC].aggregate(pipeline))

        merged: List[Dict[str, Any]] = []
        for d in docs:
            if d.get("source") == "SC":
                merged.append(_norm_sc_merged(d))
            else:
                merged.append(_norm_hc_merged(d))
        results = merged

    total = sc_total_raw + hc_total_raw
    has_more = (page * page_size) < total

    # remove helper if present
    for r in results:
        r.pop("_sort_date", None)

    return {
        "results": results,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
        "sc_total": sc_total_raw,
        "hc_total": hc_total_raw,
    }
    
# ========= Unified Statutes search (NEW) =========
def statutes_search(
    query: str,
    statutes: List[str],
    section_title: Optional[str],
    page: int,
    page_size: int,
) -> Dict[str, Any]:
    # Selection parsing
    include_central = False
    selected_states: List[str] = []
    for s in (statutes or []):
        sl = s.strip().lower()
        if sl in ("central", "central acts", "central act"):
            include_central = True
        else:
            selected_states.append(s)

    # Default to Central if nothing is selected (parity with Judgements default to SC)
    if not include_central and not selected_states:
        include_central = True

    mode = "both" if (include_central and selected_states) else ("central" if include_central else "state")
    start = max(0, (page - 1) * page_size)

    # Build match conditions
    ca_match = _build_central_match(query, section_title) if include_central else None
    sa_match = _build_state_match(query, selected_states, section_title) if selected_states else None

    # Accurate totals
    central_total_raw = DB[CA].count_documents(ca_match) if ca_match else 0
    state_total_raw   = DB[SA].count_documents(sa_match) if sa_match else 0

    results: List[Dict[str, Any]] = []

    if mode == "central":
        pipeline = [
            {"$match": ca_match or {}},
            {"$sort": {"_id": -1}},  # deterministic paging; can be changed later
            {"$skip": start},
            {"$limit": page_size},
            {"$project": {
                "Name of statute": 1, "Name of Statute": 1,
                "Section Number": 1, "Section Title": 1, "Section Text": 1,
            }},
        ]
        docs = list(DB[CA].aggregate(pipeline))
        results = [_norm_central_raw(d) for d in docs]

    elif mode == "state":
        pipeline = [
            {"$match": sa_match or {}},
            {"$sort": {"_id": -1}},
            {"$skip": start},
            {"$limit": page_size},
            {"$project": {
                "State Name": 1,
                "Name of statute": 1, "Name of Statute": 1,
                "Section Number": 1, "Section Title": 1, "Section Text": 1,
            }},
        ]
        docs = list(DB[SA].aggregate(pipeline))
        results = [_norm_state_raw(d) for d in docs]

    else:  # both central + state(s)
        ca_branch = [
            {"$match": ca_match or {}},
            {"$project": {
                "Name of statute": 1, "Name of Statute": 1,
                "Section Number": 1, "Section Title": 1, "Section Text": 1,
                "source": {"$literal": "CENTRAL"}, "collection": {"$literal": CA},
            }},
        ]
        sa_branch = [
            {"$match": sa_match or {}},
            {"$project": {
                "State Name": 1,
                "Name of statute": 1, "Name of Statute": 1,
                "Section Number": 1, "Section Title": 1, "Section Text": 1,
                "source": {"$literal": "STATE"}, "collection": {"$literal": SA},
            }},
        ]
        pipeline = ca_branch + [
            {"$unionWith": {"coll": SA, "pipeline": sa_branch}},
            {"$sort": {"_id": -1}},   # simple, deterministic
            {"$skip": start},
            {"$limit": page_size},
        ]
        docs = list(DB[CA].aggregate(pipeline))

        merged = []
        for d in docs:
            if d.get("source") == "CENTRAL":
                merged.append(_norm_central_merged(d))
            else:
                merged.append(_norm_state_merged(d))
        results = merged

    total = central_total_raw + state_total_raw
    has_more = (page * page_size) < total

    return {
        "results": results,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
        "central_total": central_total_raw,
        "state_total": state_total_raw,
    }
    
# ========= Highlight snippets builder =========
_HIGHLIGHT_FIELDS = [
    # Judgements
    "content", "text", "all_text", "title", "file_name",
    # Statutes (DB/title-case and normalized/lower-case variants)
    "Section Text", "section text",
    "Section Title", "section title",
    "Name of statute", "Name of Statute", "name of statute",
    "state name",
]

def _compile_keyword_regexes(keywords: List[str]):
    regs = []
    for kw in keywords or []:
        kw = (kw or "").strip()
        if not kw:
            continue
        regs.append(re.compile(re.escape(kw), re.IGNORECASE))
    return regs

def _highlight_text(raw: str, regs: List[re.Pattern]) -> str:
    if not raw:
        return ""
    safe = html.escape(str(raw))  # avoid HTML injection
    for rx in regs:
        safe = rx.sub(lambda m: f"<mark>{m.group(0)}</mark>", safe)
    return safe

def _extract_snippets(raw: str, regs: List[re.Pattern], max_snippets: int, window: int) -> List[str]:
    if not raw or not regs:
        return []
    text = str(raw)
    hits = []
    for rx in regs:
        for m in rx.finditer(text):
            s = max(0, m.start() - window)
            e = min(len(text), m.end() + window)
            hits.append((s, e))
    if not hits:
        return []
    hits.sort()
    merged = []
    cur_s, cur_e = hits[0]
    for s, e in hits[1:]:
        if s <= cur_e + 10:
            cur_e = max(cur_e, e)
        else:
            merged.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    merged.append((cur_s, cur_e))
    merged = merged[:max_snippets]
    return [_highlight_text(text[s:e], regs) for s, e in merged]

def build_highlight_snippets(
    doc: Dict[str, Any],
    keywords: List[str],
    max_snippets: int = 3,
    window: int = 120,
) -> Dict[str, Any]:
    regs = _compile_keyword_regexes(keywords)

    raw_text = ""
    for f in _HIGHLIGHT_FIELDS:
        if doc.get(f):
            raw_text = str(doc.get(f))
            break

    snippets = _extract_snippets(raw_text, regs, max_snippets, window)
    match_count = 0
    for rx in regs:
        match_count += len(list(rx.finditer(raw_text)))

    return {
        "source": doc.get("source"),
        "collection": doc.get("collection"),
        "file_name": doc.get("file_name"),
        "title": doc.get("title"),
        "match_count": match_count,
        "snippets": snippets,
    }
