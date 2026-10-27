import os
import re
import math
import json
import logging
from datetime import datetime
from flask import Flask, request, jsonify, render_template, send_file
from werkzeug.utils import secure_filename
import pandas as pd
import numpy as np

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Initialize Flask
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB max upload
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
app.config["SAMPLE_FOLDER"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data")
ALLOWED_EXTENSIONS = {"csv"}

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["SAMPLE_FOLDER"], exist_ok=True)

# Global in-memory state for active dataset
active_data_state = {
    "filename": None,
    "upload_time": None,
    "raw_df": None,
    "processed_df": None,
    "metadata": {},
    "analytics": None,
}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def clean_and_deduplicate_columns(columns):
    """Cleans column names, removes BOM, and ensures uniqueness."""
    cleaned = []
    seen = {}
    for i, col in enumerate(columns):
        c_str = str(col).strip().replace("\ufeff", "").replace("\n", " ").replace("\r", "")
        if not c_str or c_str.lower().startswith("unnamed:"):
            c_str = f"Column_{i+1}"
        if c_str in seen:
            seen[c_str] += 1
            c_str = f"{c_str}_{seen[c_str]}"
        else:
            seen[c_str] = 0
        cleaned.append(c_str)
    return cleaned


def sanitize_numeric_series(series):
    """Safely cleans strings with commas, currencies, percentages, dashes into float values without removing decimal points."""
    if isinstance(series, pd.DataFrame):
        series = series.iloc[:, 0]

    if pd.api.types.is_numeric_dtype(series):
        return pd.to_numeric(series, errors="coerce").fillna(0).astype(float)

    # Convert to string and clean
    cleaned = (
        series.astype(str)
        .str.strip()
        .str.replace(r"(?i)\b(?:rs\.?|inr|usd|eur|gbp)\s*", "", regex=True)
        .str.replace(r"[\$,₹,€,£\s]", "", regex=True)
        .str.replace(r"^\((.*)\)$", r"-\1", regex=True)  # Parentheses negative numbers: (100) -> -100
        .str.replace("%", "", regex=False)
        .str.replace(r"^[-—–\s\.]+$", "0", regex=True)  # Dashes, dots alone as zero (e.g. '---', '...')
        .str.replace(",", "", regex=False)
    )
    # Coerce to numeric
    numeric_series = pd.to_numeric(cleaned, errors="coerce").fillna(0).astype(float)
    return numeric_series


def detect_columns(df):
    """
    Intelligently identifies categorical, numeric, date, and key financial columns.
    Returns a dict with classification and mapped semantic roles.
    """
    col_names = df.columns.tolist()
    classification = {
        "text_cols": [],
        "numeric_cols": [],
        "potential_department_col": None,
        "actual_col": None,
        "budget_col": None,
        "revised_col": None,
        "future_budget_col": None,
        "revenue_col": None,
        "capital_col": None,
        "total_col": None,
        "year_cols": [],
        "all_numeric_cols": [],
    }

    # Classify each column
    for col in col_names:
        # Check if column is numeric or can be safely converted to numeric
        series = df[col].dropna()
        if len(series) == 0:
            classification["text_cols"].append(col)
            continue

        if pd.api.types.is_numeric_dtype(series):
            classification["numeric_cols"].append(col)
        else:
            # Check sample non-empty values
            sample = series.head(20).astype(str).str.strip()
            # If majority looks numeric when punctuation is stripped
            cleaned_sample = (
                sample.str.replace(r"(?i)\b(?:rs\.?|inr|usd|eur|gbp)\s*", "", regex=True)
                .str.replace(r"[\$,₹,€,£\s,%]", "", regex=True)
                .str.replace(r"^\((.*)\)$", r"-\1", regex=True)
                .str.replace(r"^[-—–\s\.]+$", "0", regex=True)
                .str.replace(",", "", regex=False)
            )
            converted = pd.to_numeric(cleaned_sample, errors="coerce")
            valid_ratio = converted.notna().sum() / len(cleaned_sample) if len(cleaned_sample) > 0 else 0
            if valid_ratio >= 0.6:
                classification["numeric_cols"].append(col)
            else:
                classification["text_cols"].append(col)

    classification["all_numeric_cols"] = list(classification["numeric_cols"])

    # 1. Detect Category / Department column
    dept_keywords = [
        "ministry", "department", "dept", "agency", "sector", "category",
        "head", "organization", "name", "scheme", "programme", "service",
        "account", "division", "institution", "item"
    ]
    # Check text cols first
    for col in classification["text_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in dept_keywords):
            classification["potential_department_col"] = col
            break

    # Fallback for department: text column with highest distinct values (but not all unique like an ID)
    if not classification["potential_department_col"] and classification["text_cols"]:
        best_col = classification["text_cols"][0]
        max_unique = -1
        for col in classification["text_cols"]:
            uniq = df[col].nunique()
            if uniq > max_unique:
                max_unique = uniq
                best_col = col
        classification["potential_department_col"] = best_col

    # If still none, pick the first column
    if not classification["potential_department_col"] and col_names:
        classification["potential_department_col"] = col_names[0]

    # 2. Detect Specific Financial Roles
    # Total Column
    total_keywords = ["total", "grand total", "net total", "gross", "sum"]
    for col in classification["numeric_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in total_keywords):
            classification["total_col"] = col
            break

    # Budget Column (Budget Estimate / BE / Approved / Allocated)
    budget_keywords = ["budget estimate", "be 20", "be ", "budget", "allocated", "approved", "be_"]
    for col in classification["numeric_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in budget_keywords):
            # Make sure it's not a future one if multiple exist
            if not classification["budget_col"]:
                classification["budget_col"] = col
            else:
                classification["future_budget_col"] = col

    # Actual Column
    actual_keywords = ["actual", "actuals", "expenditure", "spent", "disbursement", "disbursed", "paid"]
    for col in classification["numeric_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in actual_keywords):
            classification["actual_col"] = col
            break

    # Revised Column (RE / Revised Estimate)
    re_pattern = re.compile(r"\b(revised\s*estimate|revised|re\s*20\d\d|re\s*[-_]|re\s*\d\d)\b", re.IGNORECASE)
    for col in classification["numeric_cols"]:
        if col != classification["budget_col"] and col != classification["actual_col"]:
            if re_pattern.search(col):
                classification["revised_col"] = col
                break

    # Revenue Column
    revenue_keywords = ["revenue", "rev exp", "revenue expenditure", "operational"]
    for col in classification["numeric_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in revenue_keywords) and "total" not in col_lower:
            classification["revenue_col"] = col
            break

    # Capital Column
    capital_keywords = ["capital", "cap exp", "capital outlay", "capital expenditure", "infrastructure"]
    for col in classification["numeric_cols"]:
        col_lower = col.lower()
        if any(kw in col_lower for kw in capital_keywords) and "total" not in col_lower:
            classification["capital_col"] = col
            break

    # Detect multi-year or periodic columns
    # Pattern: 2024-25, 2025-26, 2023, 2024, FY24, FY25
    year_pattern = re.compile(r"(20\d\d[-/]\d\d|20\d\d|fy\s*\d\d)", re.IGNORECASE)
    for col in classification["numeric_cols"]:
        if year_pattern.search(col):
            classification["year_cols"].append(col)

    return classification


def process_dataframe(df):
    """
    Cleans and deduplicates column names, converts numeric columns, and replaces NaNs cleanly.
    """
    # 1. Clean and deduplicate column names
    df.columns = clean_and_deduplicate_columns(df.columns)

    # 2. Drop completely empty columns and rows
    df = df.dropna(how="all", axis=1)
    df = df.dropna(how="all", axis=0)

    # 3. Detect column types
    detected = detect_columns(df)

    # 4. Clean numeric columns
    for col in detected["numeric_cols"]:
        df[col] = sanitize_numeric_series(df[col])

    # Clean text columns
    for col in detected["text_cols"]:
        df[col] = df[col].fillna("Unknown").astype(str).str.strip()

    # Re-verify and ensure no NaNs/Infs exist in entire dataframe
    df = df.replace([np.inf, -np.inf], 0).fillna(0)

    return df, detected


def calculate_data_quality(raw_df, processed_df, detected):
    """Computes comprehensive data quality statistics."""
    total_rows = len(raw_df)
    total_cols = len(raw_df.columns)
    total_cells = total_rows * total_cols if total_rows > 0 else 1

    # Missing in raw
    missing_cells = int(raw_df.isna().sum().sum())
    missing_pct = round((missing_cells / total_cells) * 100, 2) if total_cells > 0 else 0

    # Duplicate rows
    duplicate_rows = int(raw_df.duplicated().sum())
    dup_pct = round((duplicate_rows / total_rows) * 100, 2) if total_rows > 0 else 0

    # Column type stats
    num_numeric = len(detected.get("numeric_cols", []))
    num_text = len(detected.get("text_cols", []))

    # Empty columns
    empty_cols = [str(c) for i, c in enumerate(raw_df.columns) if raw_df.iloc[:, i].isna().all()]

    # Quality score (0-100)
    score = 100.0 - (missing_pct * 0.4) - (dup_pct * 0.3)
    if empty_cols:
        score -= len(empty_cols) * 5
    score = max(10.0, min(100.0, round(score, 1)))

    # Per-column details
    col_details = []
    for i in range(len(raw_df.columns)):
        col_name = str(raw_df.columns[i]).strip().replace("\ufeff", "")
        col_series = raw_df.iloc[:, i]
        col_missing = int(col_series.isna().sum())
        col_type = "Numeric" if col_name in detected.get("numeric_cols", []) else "Text/Category"
        col_details.append({
            "name": col_name,
            "type": col_type,
            "missing_count": col_missing,
            "missing_pct": round((col_missing / total_rows) * 100, 1) if total_rows > 0 else 0,
            "distinct_count": int(col_series.nunique())
        })

    return {
        "total_rows": total_rows,
        "total_cols": total_cols,
        "missing_cells": missing_cells,
        "missing_percentage": missing_pct,
        "duplicate_rows": duplicate_rows,
        "duplicate_percentage": dup_pct,
        "numeric_columns_count": num_numeric,
        "text_columns_count": num_text,
        "empty_columns": empty_cols,
        "quality_score": score,
        "columns_breakdown": col_details
    }


def generate_rule_based_insights(analytics):
    """
    Generates intelligent AI-style financial insights derived from actual uploaded data.
    """
    insights = []
    kpis = analytics.get("kpis", {})
    distribution = analytics.get("fund_distribution", {})
    dept_ranking = analytics.get("departments_ranking", {})
    top_10 = dept_ranking.get("top_10", [])
    bottom_10 = dept_ranking.get("bottom_10", [])
    rev_cap = analytics.get("revenue_vs_capital", {})
    budget_analysis = analytics.get("budget_analysis", {})

    total_records = kpis.get("total_records", 0)
    total_amount = kpis.get("total_amount", 0)
    avg_amount = kpis.get("avg_amount", 0)
    metric_name = analytics.get("active_metric", "Fund")

    # 1. Top Allocation Insight
    if top_10:
        top1 = top_10[0]
        insights.append({
            "type": "allocation",
            "icon": "bi-trophy",
            "title": "Highest Fund Allocation",
            "text": f"The highest allocation under '{metric_name}' is assigned to {top1['name']} with {top1['formatted_amount']} ({top1['percentage']}% of the portfolio).",
            "badge": "Top Spender",
            "badge_color": "emerald"
        })

    # 2. Portfolio Concentration (Top 3)
    if len(top_10) >= 3 and total_amount > 0:
        top3_sum = sum(item["amount"] for item in top_10[:3])
        top3_pct = round((top3_sum / total_amount) * 100, 1)
        top3_names = ", ".join(item["name"] for item in top_10[:3])
        insights.append({
            "type": "concentration",
            "icon": "bi-pie-chart",
            "title": "Portfolio Concentration Risk",
            "text": f"The top 3 entities ({top3_names}) absorb {top3_pct}% of the cumulative allocation.",
            "badge": "High Concentration" if top3_pct > 50 else "Balanced",
            "badge_color": "amber" if top3_pct > 50 else "blue"
        })

    # 3. Lowest Allocation Insight
    if bottom_10:
        bot1 = bottom_10[0]
        insights.append({
            "type": "minimum",
            "icon": "bi-arrow-down-circle",
            "title": "Lowest Fund Allocation",
            "text": f"The lowest non-zero allocation belongs to {bot1['name']} with {bot1['formatted_amount']} ({bot1['percentage']}% of total).",
            "badge": "Minimal Outlay",
            "badge_color": "slate"
        })

    # 4. Expenditure & Average Overview
    if total_records > 0:
        insights.append({
            "type": "average",
            "icon": "bi-calculator",
            "title": "Average Expenditure Velocity",
            "text": f"Across {total_records} recorded administrative heads, the average allocation is {format_currency(avg_amount)} against a cumulative total of {format_currency(total_amount)}.",
            "badge": "Benchmark",
            "badge_color": "violet"
        })

    # 5. Budget Utilization & Variance
    utilization = kpis.get("utilization_rate")
    variance = kpis.get("budget_variance")
    if utilization is not None and variance is not None:
        status = "Budget Deficit / Overutilization" if variance < 0 else "Budget Surplus / Underutilized"
        color = "coral" if variance < 0 else "emerald"
        insights.append({
            "type": "budget_variance",
            "icon": "bi-bar-chart-steps",
            "title": "Fiscal Discipline & Utilization",
            "text": f"Overall budget utilization stands at {utilization}% with a net variance of {format_currency(variance)} ({status}).",
            "badge": f"{utilization}% Utilized",
            "badge_color": color
        })

    # 6. Revenue vs Capital Ratio
    if rev_cap.get("has_data"):
        rev_pct = rev_cap.get("revenue_percentage", 0)
        cap_pct = rev_cap.get("capital_percentage", 0)
        nature = "operational (Revenue)" if rev_pct > cap_pct else "asset-building (Capital)"
        insights.append({
            "type": "rev_cap",
            "icon": "bi-building-gear",
            "title": "Operational vs Capital Allocation",
            "text": f"Government allocation is predominantly {nature}: Revenue expenditure represents {rev_pct}%, while Capital infrastructure accounts for {cap_pct}%.",
            "badge": f"{cap_pct}% Capital",
            "badge_color": "cyan"
        })

    # 7. Largest Department Variance (if budget analysis exists)
    if budget_analysis.get("has_data") and budget_analysis.get("departments"):
        depts = budget_analysis["departments"]
        sorted_by_var = sorted(depts, key=lambda x: abs(x.get("variance", 0)), reverse=True)
        if sorted_by_var:
            max_var_dept = sorted_by_var[0]
            v_val = max_var_dept.get("variance", 0)
            dir_str = "under-spent" if v_val > 0 else "exceeded budget by"
            insights.append({
                "type": "variance_outlier",
                "icon": "bi-exclamation-triangle",
                "title": "Notable Variance Outlier",
                "text": f"{max_var_dept['name']} observed the largest deviation, having {dir_str} {format_currency(abs(v_val))} (Utilization: {max_var_dept.get('utilization', 0)}%).",
                "badge": "Outlier",
                "badge_color": "coral"
            })

    return insights


def format_currency(val):
    """Formats numeric values into clean human-readable strings with compact suffix."""
    if val is None or math.isnan(val):
        return "0"
    abs_v = abs(val)
    sign = "-" if val < 0 else ""
    if abs_v >= 1e9:
        return f"{sign}{round(abs_v / 1e9, 2)}B"
    if abs_v >= 1e7:
        return f"{sign}{round(abs_v / 1e7, 2)}Cr"
    if abs_v >= 1e6:
        return f"{sign}{round(abs_v / 1e6, 2)}M"
    if abs_v >= 1e3:
        return f"{sign}{round(abs_v / 1e3, 2)}K"
    return f"{sign}{round(abs_v, 2):,}"


def format_exact_number(val):
    """Returns standard comma-separated representation for tooltips and tables."""
    if val is None or math.isnan(val):
        return "0"
    return f"{round(val, 2):,}"


def compute_dashboard_analytics(df, detected, primary_metric=None, department_col=None, filter_depts=None, search_query=None):
    """
    Computes all cards, charts, distributions, and insights from df.
    """
    # Working copy
    work_df = df.copy()

    # 1. Resolve department column
    dept_col = department_col if department_col and department_col in work_df.columns else detected.get("potential_department_col")
    if not dept_col or dept_col not in work_df.columns:
        dept_col = work_df.columns[0]

    # 2. Resolve primary metric column
    metric_cols = detected.get("numeric_cols", [])
    if not metric_cols:
        # Emergency fallback: create a count column
        work_df["Count"] = 1
        metric_cols = ["Count"]

    if not primary_metric or primary_metric not in work_df.columns:
        # Default priority: Total -> Budget -> Actual -> first numeric
        if detected.get("total_col") and detected["total_col"] in work_df.columns:
            primary_metric = detected["total_col"]
        elif detected.get("budget_col") and detected["budget_col"] in work_df.columns:
            primary_metric = detected["budget_col"]
        elif detected.get("actual_col") and detected["actual_col"] in work_df.columns:
            primary_metric = detected["actual_col"]
        else:
            primary_metric = metric_cols[0]

    # 3. Apply Filters
    if search_query:
        query_str = str(search_query).strip().lower()
        mask = work_df.astype(str).apply(lambda row: row.str.lower().str.contains(query_str).any(), axis=1)
        work_df = work_df[mask]

    if filter_depts and len(filter_depts) > 0:
        work_df = work_df[work_df[dept_col].astype(str).isin(filter_depts)]

    # If filtered to empty, retain safe defaults
    total_records = len(work_df)
    unique_depts = int(work_df[dept_col].nunique()) if total_records > 0 else 0

    # Ensure primary metric is numeric
    work_df[primary_metric] = pd.to_numeric(work_df[primary_metric], errors="coerce").fillna(0)

    # Calculate Summary KPIs
    total_amount = float(work_df[primary_metric].sum()) if total_records > 0 else 0.0
    avg_amount = float(work_df[primary_metric].mean()) if total_records > 0 else 0.0
    min_amount = float(work_df[primary_metric].min()) if total_records > 0 else 0.0
    max_amount = float(work_df[primary_metric].max()) if total_records > 0 else 0.0

    kpis = {
        "total_records": total_records,
        "total_departments": unique_depts,
        "total_amount": total_amount,
        "formatted_total": format_currency(total_amount),
        "exact_total": format_exact_number(total_amount),
        "avg_amount": avg_amount,
        "formatted_avg": format_currency(avg_amount),
        "exact_avg": format_exact_number(avg_amount),
        "min_amount": min_amount,
        "formatted_min": format_currency(min_amount),
        "max_amount": max_amount,
        "formatted_max": format_currency(max_amount),
        "exact_max": format_exact_number(max_amount),
    }

    # Optional Budget KPIs
    budget_col = detected.get("budget_col")
    actual_col = detected.get("actual_col")
    revised_col = detected.get("revised_col")

    if budget_col and budget_col in work_df.columns:
        tot_b = float(work_df[budget_col].sum())
        kpis["total_budget"] = tot_b
        kpis["formatted_budget"] = format_currency(tot_b)
        kpis["exact_budget"] = format_exact_number(tot_b)
    else:
        kpis["total_budget"] = None

    if actual_col and actual_col in work_df.columns:
        tot_a = float(work_df[actual_col].sum())
        kpis["total_actual"] = tot_a
        kpis["formatted_actual"] = format_currency(tot_a)
        kpis["exact_actual"] = format_exact_number(tot_a)
    else:
        kpis["total_actual"] = None

    if revised_col and revised_col in work_df.columns:
        tot_r = float(work_df[revised_col].sum())
        kpis["total_revised"] = tot_r
        kpis["formatted_revised"] = format_currency(tot_r)
    else:
        kpis["total_revised"] = None

    # Budget Variance and Utilization
    if kpis.get("total_budget") is not None and kpis.get("total_actual") is not None:
        variance = kpis["total_budget"] - kpis["total_actual"]
        kpis["budget_variance"] = variance
        kpis["formatted_variance"] = format_currency(variance)
        kpis["exact_variance"] = format_exact_number(variance)
        kpis["utilization_rate"] = round((kpis["total_actual"] / kpis["total_budget"] * 100), 2) if kpis["total_budget"] > 0 else 0
    else:
        kpis["budget_variance"] = None
        kpis["utilization_rate"] = None

    # Filter out summary/grand total rows for departmental ranking & charts
    summary_keywords = ["total", "grand total", "net total", "subtotal", "sub total", "summary", "all ministries", "all departments"]
    summary_mask = work_df[dept_col].astype(str).str.strip().str.lower().isin(summary_keywords)
    analysis_df = work_df[~summary_mask] if (~summary_mask).any() else work_df

    # Revenue vs Capital KPIs
    rev_col = detected.get("revenue_col")
    cap_col = detected.get("capital_col")
    revenue_vs_capital = {"has_data": False}

    if rev_col and cap_col and rev_col in work_df.columns and cap_col in work_df.columns:
        tot_rev = float(work_df[rev_col].sum())
        tot_cap = float(work_df[cap_col].sum())
        rev_cap_total = tot_rev + tot_cap
        rev_pct = round((tot_rev / rev_cap_total * 100), 2) if rev_cap_total > 0 else 0
        cap_pct = round((tot_cap / rev_cap_total * 100), 2) if rev_cap_total > 0 else 0

        kpis["total_revenue"] = tot_rev
        kpis["formatted_revenue"] = format_currency(tot_rev)
        kpis["total_capital"] = tot_cap
        kpis["formatted_capital"] = format_currency(tot_cap)
        kpis["revenue_percentage"] = rev_pct
        kpis["capital_percentage"] = cap_pct

        # Top departments revenue vs capital breakdown
        top_cols = [c for c in [rev_col, cap_col] if c in analysis_df.columns and c != dept_col]
        if top_cols:
            top_rev_cap = (
                analysis_df.groupby(dept_col)[top_cols]
                .sum()
                .reset_index()
                .sort_values(by=top_cols[0], ascending=False)
                .head(8)
            )

            revenue_vs_capital = {
                "has_data": True,
                "revenue_col": rev_col,
                "capital_col": cap_col,
                "total_revenue": tot_rev,
                "formatted_revenue": format_currency(tot_rev),
                "exact_revenue": format_exact_number(tot_rev),
                "total_capital": tot_cap,
                "formatted_capital": format_currency(tot_cap),
                "exact_capital": format_exact_number(tot_cap),
                "revenue_percentage": rev_pct,
                "capital_percentage": cap_pct,
                "chart_labels": top_rev_cap[dept_col].tolist(),
                "revenue_values": [round(float(v), 2) for v in top_rev_cap[rev_col].tolist()] if rev_col in top_cols else [],
                "capital_values": [round(float(v), 2) for v in top_rev_cap[cap_col].tolist()] if cap_col in top_cols else [],
            }

    # 4. Department / Ministry Fund Distribution
    if primary_metric != dept_col:
        dept_aggregated = (
            analysis_df.groupby(dept_col)[primary_metric]
            .sum()
            .reset_index()
            .sort_values(by=primary_metric, ascending=False)
        )
    else:
        dept_aggregated = analysis_df[dept_col].value_counts().reset_index()
        dept_aggregated.columns = [dept_col, primary_metric]

    all_dept_items = []
    for _, row in dept_aggregated.iterrows():
        val = float(row[primary_metric])
        share = round((val / total_amount * 100), 2) if total_amount > 0 else 0
        all_dept_items.append({
            "name": str(row[dept_col]),
            "amount": val,
            "formatted_amount": format_currency(val),
            "exact_amount": format_exact_number(val),
            "percentage": share,
        })

    # Top 10
    top_10 = all_dept_items[:10]
    # Bottom 10 (reverse order lowest to highest, only if unique count >= 10)
    has_bottom_10 = len(all_dept_items) >= 10
    bottom_10 = list(reversed(all_dept_items[-10:])) if has_bottom_10 else []

    # Donut Share Data: Top 7 + Others
    donut_labels = []
    donut_values = []
    if len(all_dept_items) > 7:
        for item in all_dept_items[:7]:
            donut_labels.append(item["name"])
            donut_values.append(round(item["amount"], 2))
        others_val = sum(item["amount"] for item in all_dept_items[7:])
        donut_labels.append("Other Departments")
        donut_values.append(round(others_val, 2))
    else:
        for item in all_dept_items:
            donut_labels.append(item["name"])
            donut_values.append(round(item["amount"], 2))

    fund_distribution = {
        "metric": primary_metric,
        "department_col": dept_col,
        "donut_chart": {
            "labels": donut_labels,
            "values": donut_values
        },
        "top_departments_table": top_10,
    }

    departments_ranking = {
        "top_10": top_10,
        "bottom_10": bottom_10,
        "show_bottom_10": has_bottom_10,
    }

    # 5. Budget Analysis (Actual vs Budget Estimate vs Revised Estimate)
    budget_analysis = {"has_data": False}
    if budget_col and actual_col and budget_col in work_df.columns and actual_col in work_df.columns and budget_col != actual_col:
        raw_compare = [budget_col, actual_col]
        if revised_col and revised_col in work_df.columns and revised_col not in raw_compare:
            raw_compare.append(revised_col)

        compare_cols = [c for c in raw_compare if c != dept_col]

        if compare_cols:
            b_agg = (
                analysis_df.groupby(dept_col)[compare_cols]
                .sum()
                .reset_index()
                .sort_values(by=compare_cols[0], ascending=False)
                .head(10)
            )

            dept_budget_list = []
            for _, row in b_agg.iterrows():
                b_val = float(np.atleast_1d(row[budget_col])[0]) if budget_col in compare_cols else 0.0
                a_val = float(np.atleast_1d(row[actual_col])[0]) if actual_col in compare_cols else 0.0
                r_val = float(np.atleast_1d(row[revised_col])[0]) if revised_col and revised_col in compare_cols else None
                var_val = b_val - a_val
                ut_val = round((a_val / b_val * 100), 2) if b_val > 0 else 0
                dept_budget_list.append({
                    "name": str(row[dept_col]),
                    "budget": b_val,
                    "formatted_budget": format_currency(b_val),
                    "actual": a_val,
                    "formatted_actual": format_currency(a_val),
                    "revised": r_val,
                    "formatted_revised": format_currency(r_val) if r_val is not None else "-",
                    "variance": var_val,
                    "formatted_variance": format_currency(var_val),
                    "utilization": ut_val
                })

            budget_analysis = {
                "has_data": True,
                "budget_col": budget_col,
                "actual_col": actual_col,
                "revised_col": revised_col if revised_col and revised_col in work_df.columns else None,
                "labels": b_agg[dept_col].tolist(),
                "budget_series": [round(float(v), 2) for v in b_agg[budget_col].tolist()] if budget_col in compare_cols else [],
                "actual_series": [round(float(v), 2) for v in b_agg[actual_col].tolist()] if actual_col in compare_cols else [],
                "revised_series": [round(float(v), 2) for v in b_agg[revised_col].tolist()] if revised_col and revised_col in compare_cols else None,
                "departments": dept_budget_list,
            }

    # 6. Year-Wise / Period-Wise Financial Trend Analysis
    year_analysis = {"has_data": False}
    year_cols = detected.get("year_cols", [])
    if len(year_cols) >= 2:
        # Detected multiple year columns e.g. Actuals 2024-25, BE 2025-26, RE 2025-26, BE 2026-27
        trend_labels = []
        trend_values = []
        for y_col in year_cols:
            if y_col in work_df.columns:
                trend_labels.append(y_col)
                trend_values.append(round(float(work_df[y_col].sum()), 2))

        year_analysis = {
            "has_data": True,
            "mode": "columns",
            "labels": trend_labels,
            "values": trend_values,
            "metric_name": "Aggregate Period Outlay"
        }
    else:
        # Check if there is a 'Year' column in rows
        year_row_cols = [c for c in work_df.columns if "year" in c.lower() or "fy" in c.lower() or "period" in c.lower()]
        if year_row_cols:
            y_col = year_row_cols[0]
            if work_df[y_col].nunique() >= 2 and primary_metric != y_col:
                y_agg = (
                    work_df.groupby(y_col)[primary_metric]
                    .sum()
                    .reset_index()
                    .sort_values(by=y_col)
                )
                year_analysis = {
                    "has_data": True,
                    "mode": "row_series",
                    "labels": [str(x) for x in y_agg[y_col].tolist()],
                    "values": [round(float(v), 2) for v in y_agg[primary_metric].tolist()],
                    "metric_name": primary_metric
                }

    # 7. Expenditure Comparison across Available Metrics
    comparison_analysis = {"has_data": False}
    if len(metric_cols) >= 2:
        chosen_metrics = [primary_metric] if primary_metric in metric_cols and primary_metric != dept_col else []
        for m in metric_cols:
            if m != dept_col and m not in chosen_metrics and len(chosen_metrics) < 4:
                chosen_metrics.append(m)

        if len(chosen_metrics) >= 2:
            sort_col = chosen_metrics[0]
            top_compare = (
                analysis_df.groupby(dept_col)[chosen_metrics]
                .sum()
                .reset_index()
                .sort_values(by=sort_col, ascending=False)
                .head(6)
            )
            datasets = []
            for m_col in chosen_metrics:
                datasets.append({
                    "label": m_col,
                    "values": [round(float(v), 2) for v in top_compare[m_col].tolist()]
                })

            comparison_analysis = {
                "has_data": True,
                "labels": top_compare[dept_col].tolist(),
                "datasets": datasets,
                "metrics": chosen_metrics
            }

    # Assembly
    analytics_payload = {
        "active_metric": primary_metric,
        "department_column": dept_col,
        "all_metrics": metric_cols,
        "all_departments": sorted(df[dept_col].dropna().astype(str).unique().tolist()) if dept_col in df.columns else [],
        "kpis": kpis,
        "fund_distribution": fund_distribution,
        "departments_ranking": departments_ranking,
        "budget_analysis": budget_analysis,
        "revenue_vs_capital": revenue_vs_capital,
        "year_analysis": year_analysis,
        "comparison_analysis": comparison_analysis,
    }

    # Generate Rule-Based AI Insights
    analytics_payload["insights"] = generate_rule_based_insights(analytics_payload)

    return analytics_payload


# ==========================================
# FLASK ROUTES
# ==========================================

@app.route("/")
def index():
    """Renders the dashboard page."""
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    """Returns application status and active dataset health."""
    return jsonify({
        "status": "healthy",
        "service": "Government Fund Analyzer",
        "version": "1.0.0",
        "active_dataset": active_data_state["filename"],
        "records_loaded": len(active_data_state["processed_df"]) if active_data_state["processed_df"] is not None else 0,
        "timestamp": datetime.now().isoformat()
    })


@app.route("/upload", methods=["POST"])
def upload_file():
    """Handles CSV upload, parses, cleans, computes analytics."""
    try:
        if "file" not in request.files:
            return jsonify({"success": False, "error": "No file part in the request"}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"success": False, "error": "No file selected for upload"}), 400

        if not allowed_file(file.filename):
            return jsonify({"success": False, "error": "Invalid file format. Please upload a .csv file."}), 400

        raw_filename = file.filename or "uploaded_data.csv"
        safe_name = secure_filename(raw_filename)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        if not safe_name or not safe_name.lower().endswith(".csv"):
            safe_name = f"dataset_{timestamp}.csv"
        saved_filename = f"{timestamp}_{safe_name}"
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], saved_filename)
        file.save(filepath)

        # Check for empty file
        if os.path.exists(filepath) and os.path.getsize(filepath) == 0:
            return jsonify({"success": False, "error": "The uploaded CSV file is empty."}), 400

        # Read CSV with robust encoding and delimiter autodetection
        encodings = ["utf-8-sig", "utf-8", "latin1", "cp1252"]
        raw_df = None
        read_error = None

        for enc in encodings:
            try:
                # Try auto-detecting separator (comma, semicolon, tab, pipe)
                try:
                    raw_df = pd.read_csv(filepath, encoding=enc, sep=None, engine="python", on_bad_lines="skip")
                except Exception:
                    raw_df = pd.read_csv(filepath, encoding=enc, on_bad_lines="skip")
                if raw_df is not None and not raw_df.empty:
                    break
            except Exception as e:
                read_error = e
                continue

        if raw_df is None or raw_df.empty:
            err_msg = str(read_error) if read_error else "The uploaded CSV file is empty or could not be parsed."
            return jsonify({"success": False, "error": f"Failed to parse CSV: {err_msg}"}), 400

        # Process and clean dataframe
        processed_df, detected = process_dataframe(raw_df)

        if processed_df.empty:
            return jsonify({"success": False, "error": "The uploaded CSV has no valid data rows after cleaning."}), 400

        # Calculate Data Quality
        quality_report = calculate_data_quality(raw_df, processed_df, detected)

        # Compute Analytics
        analytics = compute_dashboard_analytics(processed_df, detected)

        # Display filename
        display_name = raw_filename if raw_filename else safe_name

        # Store in global state
        active_data_state["filename"] = display_name
        active_data_state["upload_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        active_data_state["raw_df"] = raw_df
        active_data_state["processed_df"] = processed_df
        active_data_state["metadata"] = detected
        active_data_state["quality"] = quality_report
        active_data_state["analytics"] = analytics

        return jsonify({
            "success": True,
            "message": "File uploaded and analyzed successfully",
            "filename": display_name,
            "upload_time": active_data_state["upload_time"],
            "rows_detected": len(processed_df),
            "columns_detected": len(processed_df.columns),
            "detected_roles": {
                "department_column": detected["potential_department_col"],
                "total_column": detected["total_col"],
                "budget_column": detected["budget_col"],
                "actual_column": detected["actual_col"],
                "revenue_column": detected["revenue_col"],
                "capital_column": detected["capital_col"],
                "numeric_columns": detected["numeric_cols"]
            },
            "analytics": analytics,
            "quality": quality_report
        })

    except Exception as e:
        logger.exception("Upload analysis error: %s", e)
        return jsonify({"success": False, "error": f"Failed to analyze CSV: {str(e)}"}), 500


@app.route("/analyze", methods=["POST"])
def analyze_dataset():
    """
    Recomputes analytics on the currently loaded dataset with custom metric,
    department selection, or text filters.
    """
    try:
        if active_data_state["processed_df"] is None:
            return jsonify({"success": False, "error": "No active dataset loaded. Please upload a CSV first."}), 400

        data = request.get_json() or {}
        primary_metric = data.get("metric")
        department_col = data.get("department_col")
        departments = data.get("departments")
        search = data.get("search")

        analytics = compute_dashboard_analytics(
            active_data_state["processed_df"],
            active_data_state["metadata"],
            primary_metric=primary_metric,
            department_col=department_col,
            filter_depts=departments,
            search_query=search
        )
        active_data_state["analytics"] = analytics

        return jsonify({
            "success": True,
            "filename": active_data_state["filename"],
            "analytics": analytics,
            "quality": active_data_state.get("quality")
        })

    except Exception as e:
        logger.exception("Re-analysis error: %s", e)
        return jsonify({"success": False, "error": f"Analysis calculation error: {str(e)}"}), 500


@app.route("/data", methods=["GET"])
def get_data_table():
    """
    Returns paginated, searchable, and sortable table rows from the active dataset.
    """
    try:
        if active_data_state["processed_df"] is None:
            return jsonify({"success": False, "rows": [], "total_rows": 0, "columns": []})

        df = active_data_state["processed_df"].copy()

        # Filtering / Search
        search = request.args.get("search", "").strip().lower()
        if search:
            mask = df.astype(str).apply(lambda row: row.str.lower().str.contains(search).any(), axis=1)
            df = df[mask]

        dept_col = active_data_state["metadata"].get("potential_department_col")
        dept_filter = request.args.get("department", "").strip()
        if dept_filter and dept_col and dept_col in df.columns:
            df = df[df[dept_col].astype(str) == dept_filter]

        total_filtered_rows = len(df)

        # Sorting
        sort_by = request.args.get("sort_by")
        sort_order = request.args.get("sort_order", "asc").lower()
        if sort_by and sort_by in df.columns:
            ascending = sort_order == "asc"
            df = df.sort_values(by=sort_by, ascending=ascending)

        # Pagination
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = max(1, min(1000, int(request.args.get("page_size", 25))))
        except ValueError:
            page = 1
            page_size = 25

        total_pages = max(1, math.ceil(total_filtered_rows / page_size))
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size

        page_df = df.iloc[start_idx:end_idx]

        # Convert rows with proper formatting
        rows = page_df.to_dict(orient="records")
        columns = [{"name": c, "is_numeric": c in active_data_state["metadata"].get("numeric_cols", [])} for c in df.columns]

        return jsonify({
            "success": True,
            "rows": rows,
            "total_rows": len(active_data_state["processed_df"]),
            "filtered_rows": total_filtered_rows,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
            "columns": columns
        })

    except Exception as e:
        logger.exception("Data table fetch error: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/download", methods=["GET"])
def download_processed_csv():
    """Exports the cleaned active dataset as a CSV attachment."""
    try:
        if active_data_state["processed_df"] is None:
            return jsonify({"error": "No active dataset to download"}), 400

        out_path = os.path.join(app.config["UPLOAD_FOLDER"], "processed_government_fund_data.csv")
        active_data_state["processed_df"].to_csv(out_path, index=False)
        return send_file(out_path, as_attachment=True, download_name="processed_government_fund_data.csv")
    except Exception as e:
        logger.exception("Download error: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/load_sample", methods=["POST"])
def load_sample_dataset():
    """Loads the pre-packaged authentic government expenditure dataset."""
    try:
        sample_path = os.path.join(app.config["SAMPLE_FOLDER"], "government_expenditure_budget.csv")
        if not os.path.exists(sample_path):
            sample_path = os.path.join(app.config["UPLOAD_FOLDER"], "government_expenditure_budget.csv")

        if not os.path.exists(sample_path):
            return jsonify({"success": False, "error": "Sample dataset file not found on server."}), 404

        raw_df = pd.read_csv(sample_path)
        processed_df, detected = process_dataframe(raw_df)
        quality_report = calculate_data_quality(raw_df, processed_df, detected)
        analytics = compute_dashboard_analytics(processed_df, detected)

        active_data_state["filename"] = "government_expenditure_budget.csv (Sample)"
        active_data_state["upload_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        active_data_state["raw_df"] = raw_df
        active_data_state["processed_df"] = processed_df
        active_data_state["metadata"] = detected
        active_data_state["quality"] = quality_report
        active_data_state["analytics"] = analytics

        return jsonify({
            "success": True,
            "message": "Sample government expenditure dataset loaded successfully",
            "filename": active_data_state["filename"],
            "upload_time": active_data_state["upload_time"],
            "rows_detected": len(processed_df),
            "columns_detected": len(processed_df.columns),
            "detected_roles": {
                "department_column": detected["potential_department_col"],
                "total_column": detected["total_col"],
                "budget_column": detected["budget_col"],
                "actual_column": detected["actual_col"],
                "revenue_column": detected["revenue_col"],
                "capital_column": detected["capital_col"],
                "numeric_columns": detected["numeric_cols"]
            },
            "analytics": analytics,
            "quality": quality_report
        })

    except Exception as e:
        logger.exception("Load sample error: %s", e)
        return jsonify({"success": False, "error": f"Failed to load sample dataset: {str(e)}"}), 500


def preload_sample_if_available():
    """Preloads the default sample dataset if available so the app starts fully populated."""
    try:
        sample_path = os.path.join(app.config["SAMPLE_FOLDER"], "government_expenditure_budget.csv")
        if not os.path.exists(sample_path):
            sample_path = os.path.join(app.config["UPLOAD_FOLDER"], "government_expenditure_budget.csv")

        if os.path.exists(sample_path):
            raw_df = pd.read_csv(sample_path)
            proc_df, det = process_dataframe(raw_df)
            active_data_state["filename"] = "government_expenditure_budget.csv (Sample)"
            active_data_state["upload_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            active_data_state["raw_df"] = raw_df
            active_data_state["processed_df"] = proc_df
            active_data_state["metadata"] = det
            active_data_state["quality"] = calculate_data_quality(raw_df, proc_df, det)
            active_data_state["analytics"] = compute_dashboard_analytics(proc_df, det)
            logger.info("Preloaded sample dataset successfully: %s rows", len(proc_df))
    except Exception as e:
        logger.warning("Could not preload sample dataset: %s", e)

# Preload on app initialization
preload_sample_if_available()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    try:
        app.run(host="0.0.0.0", port=port, debug=True)
    except OSError:
        logger.warning("Port %s could not be bound. Launching on port 5001...", port)
        app.run(host="0.0.0.0", port=5001, debug=True)
