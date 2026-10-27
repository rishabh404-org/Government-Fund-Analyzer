/**
 * GOVERNMENT FUND ANALYZER
 * Client-Side Controller & Chart Visualization Engine
 */

// Global State
const appState = {
    currentAnalytics: null,
    currentQuality: null,
    activeMetric: null,
    activeDepartment: "ALL",
    searchQuery: "",
    selectedFile: null,
    // Table state
    tablePage: 1,
    tablePageSize: 25,
    tableSortBy: null,
    tableSortOrder: "asc",
    tableSearch: "",
    // Chart instances registry
    charts: {}
};

// =====================================================================
// CHART.JS THEME DEFAULTS & GRADIENT UTILITIES
// =====================================================================

function getThemeColors() {
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    return {
        isDark,
        textColor: isDark ? "#F8FAFC" : "#0F172A",
        secondaryText: isDark ? "#94A3B8" : "#475569",
        gridColor: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
        tooltipBg: isDark ? "rgba(14, 19, 31, 0.95)" : "rgba(255, 255, 255, 0.95)",
        tooltipText: isDark ? "#FFFFFF" : "#0F172A",
        tooltipBorder: isDark ? "rgba(255, 87, 34, 0.4)" : "rgba(255, 87, 34, 0.3)",
        coral: "#FF5722",
        coralAlpha: "rgba(255, 87, 34, 0.25)",
        coralGradientStart: "#FF6B4A",
        coralGradientEnd: "#FF441F",
        emerald: "#10B981",
        emeraldAlpha: "rgba(16, 185, 129, 0.2)",
        cyan: "#06B6D4",
        amber: "#F59E0B",
        purple: "#8B5CF6",
        blue: "#3B82F6",
        palette: [
            "#FF5722", "#10B981", "#06B6D4", "#F59E0B",
            "#8B5CF6", "#3B82F6", "#EC4899", "#14B8A6",
            "#F97316", "#6366F1", "#84CC16", "#A855F7"
        ]
    };
}

function destroyChart(id) {
    if (appState.charts[id]) {
        try {
            appState.charts[id].destroy();
        } catch (e) {
            console.warn("Chart destroy error", e);
        }
        delete appState.charts[id];
    }
}

// =====================================================================
// NOTIFICATION TOAST SYSTEM
// =====================================================================

function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    
    let icon = "bi-info-circle-fill";
    if (type === "success") icon = "bi-check-circle-fill";
    if (type === "error") icon = "bi-exclamation-triangle-fill";

    toast.innerHTML = `
        <i class="bi ${icon}"></i>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// =====================================================================
// INITIALIZATION
// =====================================================================

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    bindEventListeners();
    loadInitialData();
});

function initTheme() {
    const savedTheme = localStorage.getItem("gov_analyzer_theme") || "dark";
    setTheme(savedTheme);

    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) {
        themeBtn.addEventListener("click", () => {
            const current = document.documentElement.getAttribute("data-theme") || "dark";
            const next = current === "dark" ? "light" : "dark";
            setTheme(next);
            // Re-render charts with updated theme colors
            if (appState.currentAnalytics) {
                renderAllCharts(appState.currentAnalytics);
            }
        });
    }
}

function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gov_analyzer_theme", theme);
    const icon = document.getElementById("theme-icon");
    if (icon) {
        icon.className = theme === "dark" ? "bi bi-sun" : "bi bi-moon-stars";
    }
}

function bindEventListeners() {
    // Modal controls
    const openUploadBtn = document.getElementById("open-upload-btn");
    const heroUploadTrigger = document.getElementById("hero-upload-trigger");
    const closeModalBtn = document.getElementById("close-modal-btn");
    const cancelUploadBtn = document.getElementById("cancel-upload-btn");
    const uploadModal = document.getElementById("upload-modal");

    const openModal = () => {
        uploadModal.classList.add("active");
        uploadModal.setAttribute("aria-hidden", "false");
    };

    const closeModal = () => {
        uploadModal.classList.remove("active");
        uploadModal.setAttribute("aria-hidden", "true");
        resetUploadModal();
    };

    if (openUploadBtn) openUploadBtn.addEventListener("click", openModal);
    if (heroUploadTrigger) heroUploadTrigger.addEventListener("click", openModal);
    if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
    if (cancelUploadBtn) cancelUploadBtn.addEventListener("click", closeModal);

    // Drop zone & file picker
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("csv-file-input");
    const removeFileBtn = document.getElementById("remove-file-btn");
    const startUploadBtn = document.getElementById("start-upload-btn");

    if (dropZone && fileInput) {
        dropZone.addEventListener("click", (e) => {
            if (e.target !== fileInput) {
                fileInput.value = "";
                fileInput.click();
            }
        });

        ["dragenter", "dragover"].forEach(evt => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add("dragover");
            });
        });

        ["dragleave", "drop"].forEach(evt => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove("dragover");
            });
        });

        dropZone.addEventListener("drop", (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) handleFileSelection(files[0]);
        });

        fileInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files.length > 0) {
                handleFileSelection(e.target.files[0]);
            }
        });
    }

    if (removeFileBtn) {
        removeFileBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            resetUploadModal();
        });
    }

    if (startUploadBtn) {
        startUploadBtn.addEventListener("click", executeUpload);
    }

    // Load sample buttons
    const loadSampleBtn = document.getElementById("load-sample-btn");
    const heroSampleTrigger = document.getElementById("hero-sample-trigger");
    const loadSampleFromModal = document.getElementById("load-sample-from-modal");

    const triggerSample = () => {
        closeModal();
        loadSampleDataset();
    };

    if (loadSampleBtn) loadSampleBtn.addEventListener("click", triggerSample);
    if (heroSampleTrigger) heroSampleTrigger.addEventListener("click", triggerSample);
    if (loadSampleFromModal) loadSampleFromModal.addEventListener("click", triggerSample);

    // Refresh analysis button
    const refreshBtn = document.getElementById("refresh-analysis-btn");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            recalculateAnalytics();
        });
    }

    // Filter controls
    const applyFiltersBtn = document.getElementById("apply-filters-btn");
    const clearFiltersBtn = document.getElementById("clear-filters-btn");

    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener("click", () => {
            applyFilterMatrix();
        });
    }

    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener("click", () => {
            clearFilterMatrix();
        });
    }

    // Distribution section metric selector
    const distMetricSelect = document.getElementById("distribution-metric-select");
    if (distMetricSelect) {
        distMetricSelect.addEventListener("change", (e) => {
            const chosen = e.target.value;
            const mainSelect = document.getElementById("metric-select");
            if (mainSelect) mainSelect.value = chosen;
            appState.activeMetric = chosen;
            recalculateAnalytics({ metric: chosen });
        });
    }

    // Main Filter Metric selector change
    const mainMetricSelect = document.getElementById("metric-select");
    if (mainMetricSelect) {
        mainMetricSelect.addEventListener("change", (e) => {
            appState.activeMetric = e.target.value;
            const distSelect = document.getElementById("distribution-metric-select");
            if (distSelect) distSelect.value = e.target.value;
        });
    }

    // Table search debounce
    const tableSearchInput = document.getElementById("table-search-input");
    if (tableSearchInput) {
        let debounceTimer;
        tableSearchInput.addEventListener("input", (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                appState.tableSearch = e.target.value.trim();
                appState.tablePage = 1;
                fetchTableData();
            }, 300);
        });
    }

    // Table page size selector
    const tablePageSize = document.getElementById("table-page-size");
    if (tablePageSize) {
        tablePageSize.addEventListener("change", (e) => {
            appState.tablePageSize = parseInt(e.target.value);
            appState.tablePage = 1;
            fetchTableData();
        });
    }

    // Download Chart PNG buttons
    document.querySelectorAll(".download-chart-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const chartId = btn.getAttribute("data-chart");
            downloadChartAsImage(chartId);
        });
    });
}

// =====================================================================
// FILE SELECTION & UPLOAD HANDLERS
// =====================================================================

function handleFileSelection(file) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
        showToast("Only .CSV files are supported.", "error");
        return;
    }

    appState.selectedFile = file;

    const dropZone = document.getElementById("drop-zone");
    const fileCard = document.getElementById("selected-file-card");
    const fileName = document.getElementById("selected-file-name");
    const fileSize = document.getElementById("selected-file-size");
    const startUploadBtn = document.getElementById("start-upload-btn");

    dropZone.classList.add("d-none");
    fileCard.classList.remove("d-none");

    fileName.textContent = file.name;
    fileSize.textContent = (file.size / 1024).toFixed(1) + " KB";
    startUploadBtn.disabled = false;
}

function resetUploadModal() {
    appState.selectedFile = null;
    const fileInput = document.getElementById("csv-file-input");
    if (fileInput) fileInput.value = "";

    const dropZone = document.getElementById("drop-zone");
    const fileCard = document.getElementById("selected-file-card");
    const progressWrap = document.getElementById("upload-progress-container");
    const startUploadBtn = document.getElementById("start-upload-btn");
    const progressBar = document.getElementById("upload-progress-bar");

    if (dropZone) dropZone.classList.remove("d-none");
    if (fileCard) fileCard.classList.add("d-none");
    if (progressWrap) progressWrap.classList.add("d-none");
    if (startUploadBtn) startUploadBtn.disabled = true;
    if (progressBar) progressBar.style.width = "0%";

    ["chk-upload", "chk-rows", "chk-cols", "chk-analysis"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove("done");
    });
}

async function executeUpload() {
    if (!appState.selectedFile) return;

    const startUploadBtn = document.getElementById("start-upload-btn");
    const progressWrap = document.getElementById("upload-progress-container");
    const progressBar = document.getElementById("upload-progress-bar");

    startUploadBtn.disabled = true;
    progressWrap.classList.remove("d-none");

    // Simulated animated checklist progression
    progressBar.style.width = "25%";
    document.getElementById("chk-upload").classList.add("done");

    const formData = new FormData();
    formData.append("file", appState.selectedFile);

    try {
        setTimeout(() => {
            progressBar.style.width = "55%";
            document.getElementById("chk-rows").classList.add("done");
        }, 300);

        const response = await fetch("/upload", {
            method: "POST",
            body: formData
        });

        let data;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            data = await response.json();
        } else {
            const errorText = await response.text();
            throw new Error(`Server returned status ${response.status}: ${errorText.substring(0, 120)}`);
        }

        if (!response.ok || !data.success) {
            throw new Error(data.error || `Upload failed with status ${response.status}`);
        }

        progressBar.style.width = "85%";
        document.getElementById("chk-cols").classList.add("done");

        setTimeout(() => {
            progressBar.style.width = "100%";
            document.getElementById("chk-analysis").classList.add("done");
        }, 200);

        setTimeout(() => {
            try {
                // Apply new analytics
                updateDashboard(data.analytics, data.filename, data.upload_time, data.quality);
                const uploadModal = document.getElementById("upload-modal");
                if (uploadModal) uploadModal.classList.remove("active");
                resetUploadModal();
                showToast(`Analysis completed: ${data.rows_detected} rows and ${data.columns_detected} columns processed.`, "success");
            } catch (renderErr) {
                console.error("Dashboard render error:", renderErr);
                showToast(`Data processed, but display encountered an issue: ${renderErr.message}`, "error");
                const uploadModal = document.getElementById("upload-modal");
                if (uploadModal) uploadModal.classList.remove("active");
                resetUploadModal();
            }
        }, 700);

    } catch (err) {
        console.error("Upload error:", err);
        showToast(err.message || "Failed to process CSV file.", "error");
        startUploadBtn.disabled = false;
        progressBar.style.width = "0%";
    }
}

async function loadSampleDataset() {
    try {
        showToast("Loading authentic government expenditure dataset...", "info");
        const response = await fetch("/load_sample", { method: "POST" });
        const data = await response.json();

        if (data.success) {
            updateDashboard(data.analytics, data.filename, data.upload_time, data.quality);
            showToast("Sample dataset loaded successfully.", "success");
        } else {
            showToast(data.error || "Failed to load sample dataset.", "error");
        }
    } catch (err) {
        console.error("Load sample error:", err);
        showToast("Error connecting to server.", "error");
    }
}

// =====================================================================
// INITIAL DATA FETCH & RE-ANALYSIS
// =====================================================================

async function loadInitialData() {
    try {
        const response = await fetch("/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });

        const data = await response.json();

        if (data.success && data.analytics) {
            updateDashboard(data.analytics, data.filename, "Initial Launch", data.quality);
        } else {
            // If nothing is loaded yet, attempt sample preload
            loadSampleDataset();
        }
    } catch (err) {
        console.warn("Initial load fetch fallback:", err);
        loadSampleDataset();
    }
}

async function recalculateAnalytics(customParams = {}) {
    const payload = {
        metric: customParams.metric || appState.activeMetric,
        department_col: customParams.department_col || null,
        departments: (appState.activeDepartment && appState.activeDepartment !== "ALL") ? [appState.activeDepartment] : null,
        search: appState.searchQuery || null,
        ...customParams
    };

    try {
        const response = await fetch("/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.success && data.analytics) {
            updateDashboard(data.analytics, data.filename, null, data.quality);
            showToast("Analytics updated dynamically.", "info");
        }
    } catch (err) {
        console.error("Recalculate error:", err);
        showToast("Error recalculating analytics.", "error");
    }
}

function applyFilterMatrix() {
    const metricSelect = document.getElementById("metric-select");
    const deptSelect = document.getElementById("department-select");
    const searchInput = document.getElementById("search-input");

    appState.activeMetric = metricSelect ? metricSelect.value : null;
    appState.activeDepartment = deptSelect ? deptSelect.value : "ALL";
    appState.searchQuery = searchInput ? searchInput.value.trim() : "";

    recalculateAnalytics();
}

function clearFilterMatrix() {
    const deptSelect = document.getElementById("department-select");
    const searchInput = document.getElementById("search-input");

    if (deptSelect) deptSelect.value = "ALL";
    if (searchInput) searchInput.value = "";

    appState.activeDepartment = "ALL";
    appState.searchQuery = "";

    recalculateAnalytics();
}

// =====================================================================
// CORE DASHBOARD UPDATE ROUTINE
// =====================================================================

function updateDashboard(analytics, filename, uploadTime, quality) {
    if (!analytics) return;

    appState.currentAnalytics = analytics;
    appState.currentQuality = quality;
    appState.activeMetric = analytics.active_metric;

    // 1. Update Header & Meta Strip
    if (filename) {
        const metaFile = document.getElementById("meta-filename");
        if (metaFile) metaFile.textContent = filename;
    }
    if (uploadTime) {
        const metaUpdated = document.getElementById("meta-updated");
        if (metaUpdated) metaUpdated.textContent = uploadTime;
    }

    // 2. Populate Filter Options
    populateFilterDropdowns(analytics);

    // 3. Render KPI Cards
    renderKpiCards(analytics.kpis, analytics.active_metric);

    // 4. Render Hero Showcase
    renderHeroShowcase(analytics);

    // 5. Render Rule-Based AI Insights
    renderAiInsights(analytics.insights);

    // 6. Render Charts
    renderAllCharts(analytics);

    // 7. Render Data Quality
    if (quality) {
        renderDataQuality(quality);
    }

    // 8. Refresh Main Data Table
    fetchTableData();
}

function populateFilterDropdowns(analytics) {
    const metricSelect = document.getElementById("metric-select");
    const distMetricSelect = document.getElementById("distribution-metric-select");
    const deptSelect = document.getElementById("department-select");

    // Metrics dropdown
    const metrics = analytics.all_metrics || [];
    const metricOptionsHtml = metrics.map(m => `
        <option value="${m}" ${m === analytics.active_metric ? "selected" : ""}>${m}</option>
    `).join("");

    if (metricSelect) metricSelect.innerHTML = metricOptionsHtml;
    if (distMetricSelect) distMetricSelect.innerHTML = metricOptionsHtml;

    // Departments dropdown
    if (deptSelect && analytics.all_departments) {
        let deptHtml = `<option value="ALL">All Departments (${analytics.all_departments.length})</option>`;
        deptHtml += analytics.all_departments.map(d => `
            <option value="${d}" ${d === appState.activeDepartment ? "selected" : ""}>${d}</option>
        `).join("");
        deptSelect.innerHTML = deptHtml;
    }
}

// =====================================================================
// KPI CARDS RENDERING
// =====================================================================

function renderKpiCards(kpis, primaryMetric) {
    if (!kpis) return;

    // Basic Cards
    setText("kpi-records", kpis.total_records || 0);
    setText("kpi-departments", kpis.total_departments || 0);
    setText("kpi-primary-label", `Total ${primaryMetric || "Outlay"}`);
    setText("kpi-total-amount", kpis.formatted_total || "0");
    setText("kpi-total-exact", `Exact: ${kpis.exact_total || "0"}`);
    setText("kpi-average", kpis.formatted_avg || "0");
    setText("kpi-average-exact", `Exact: ${kpis.exact_avg || "0"}`);
    setText("kpi-max", kpis.formatted_max || "0");
    setText("kpi-max-exact", `Exact: ${kpis.exact_max || "0"}`);

    // Total Budget
    const cardBudget = document.getElementById("card-total-budget");
    if (kpis.total_budget !== null && kpis.total_budget !== undefined) {
        if (cardBudget) cardBudget.style.display = "flex";
        setText("kpi-budget", kpis.formatted_budget);
        setText("kpi-budget-exact", `Exact: ${kpis.exact_budget}`);
    } else if (cardBudget) {
        cardBudget.style.display = "none";
    }

    // Total Actual
    const cardActual = document.getElementById("card-total-actual");
    if (kpis.total_actual !== null && kpis.total_actual !== undefined) {
        if (cardActual) cardActual.style.display = "flex";
        setText("kpi-actual", kpis.formatted_actual);
        setText("kpi-actual-exact", `Exact: ${kpis.exact_actual}`);
    } else if (cardActual) {
        cardActual.style.display = "none";
    }

    // Budget Variance
    const cardVariance = document.getElementById("card-variance");
    if (kpis.budget_variance !== null && kpis.budget_variance !== undefined) {
        if (cardVariance) cardVariance.style.display = "flex";
        setText("kpi-variance", kpis.formatted_variance);
        const statusText = kpis.budget_variance >= 0 ? "Surplus / Unspent" : "Budget Deficit";
        setText("kpi-variance-status", statusText);
    } else if (cardVariance) {
        cardVariance.style.display = "none";
    }

    // Utilization
    const cardUtil = document.getElementById("card-utilization");
    if (kpis.utilization_rate !== null && kpis.utilization_rate !== undefined) {
        if (cardUtil) cardUtil.style.display = "flex";
        setText("kpi-utilization", `${kpis.utilization_rate}%`);
        setText("kpi-utilization-sub", kpis.utilization_rate >= 100 ? "Exceeded Budget" : "Normal Velocity");
    } else if (cardUtil) {
        cardUtil.style.display = "none";
    }

    // Revenue
    const cardRevenue = document.getElementById("card-revenue");
    if (kpis.total_revenue !== null && kpis.total_revenue !== undefined) {
        if (cardRevenue) cardRevenue.style.display = "flex";
        setText("kpi-revenue", kpis.formatted_revenue);
        setText("kpi-revenue-pct", `${kpis.revenue_percentage || 0}% of Total`);
    } else if (cardRevenue) {
        cardRevenue.style.display = "none";
    }

    // Capital
    const cardCapital = document.getElementById("card-capital");
    if (kpis.total_capital !== null && kpis.total_capital !== undefined) {
        if (cardCapital) cardCapital.style.display = "flex";
        setText("kpi-capital", kpis.formatted_capital);
        setText("kpi-capital-pct", `${kpis.capital_percentage || 0}% of Total`);
    } else if (cardCapital) {
        cardCapital.style.display = "none";
    }
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// =====================================================================
// HERO SHOWCASE RENDERING
// =====================================================================

function renderHeroShowcase(analytics) {
    const kpis = analytics.kpis || {};
    const top10 = analytics.departments_ranking?.top_10 || [];

    // Hero stat pills
    setText("hero-stat-records", `${kpis.total_records || 0} Heads`);
    setText("hero-stat-total", kpis.formatted_total || "0");
    setText("hero-stat-util", kpis.utilization_rate !== null ? `${kpis.utilization_rate}%` : "100%");

    // Floating orange accent card
    if (top10.length > 0) {
        const top1 = top10[0];
        setText("hero-top-amount", top1.formatted_amount);
        setText("hero-top-share", `${top1.percentage}%`);
        setText("hero-top-dept", top1.name);
    }

    // Bottom tip pill
    if (analytics.insights && analytics.insights.length > 0) {
        const tip = analytics.insights.find(i => i.type === "concentration") || analytics.insights[0];
        setText("hero-tip-text", tip.text);
    }

    // Render Hero Glowing Trend Chart
    renderHeroTrendChart(analytics);
}

function renderHeroTrendChart(analytics) {
    const ctx = document.getElementById("heroTrendChart");
    if (!ctx) return;

    destroyChart("heroTrendChart");

    const theme = getThemeColors();
    let labels = [];
    let values = [];

    // If multi-year data exists, use it; else top 7 departments
    if (analytics.year_analysis?.has_data) {
        labels = analytics.year_analysis.labels;
        values = analytics.year_analysis.values;
    } else if (analytics.fund_distribution?.top_departments_table) {
        const depts = analytics.fund_distribution.top_departments_table.slice(0, 7);
        labels = depts.map(d => d.name.length > 15 ? d.name.substring(0, 15) + "..." : d.name);
        values = depts.map(d => d.amount);
    }

    if (labels.length === 0) return;

    const chartGradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 200);
    chartGradient.addColorStop(0, "rgba(255, 87, 34, 0.45)");
    chartGradient.addColorStop(0.7, "rgba(255, 87, 34, 0.08)");
    chartGradient.addColorStop(1, "rgba(255, 87, 34, 0)");

    appState.charts["heroTrendChart"] = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [{
                data: values,
                borderColor: theme.coral,
                borderWidth: 3,
                backgroundColor: chartGradient,
                fill: true,
                tension: 0.42,
                pointBackgroundColor: theme.coral,
                pointBorderColor: "#FFFFFF",
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 7,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: theme.tooltipBg,
                    titleColor: theme.tooltipText,
                    bodyColor: theme.coral,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: (ctx) => `Amount: ${ctx.parsed.y.toLocaleString()}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: theme.secondaryText, font: { size: 10 } }
                },
                y: {
                    grid: { color: theme.gridColor },
                    ticks: {
                        color: theme.secondaryText,
                        font: { size: 10 },
                        callback: (v) => formatCompactNumber(v)
                    }
                }
            }
        }
    });
}

// =====================================================================
// AI FINANCIAL INSIGHTS RENDERING
// =====================================================================

function renderAiInsights(insights) {
    const container = document.getElementById("insights-container");
    if (!container) return;

    if (!insights || insights.length === 0) {
        container.innerHTML = `<p class="text-muted">No specific insights available for this dataset structure.</p>`;
        return;
    }

    container.innerHTML = insights.map(item => `
        <div class="insight-card glass-panel">
            <div>
                <div class="insight-top">
                    <div class="insight-icon-pill">
                        <i class="bi ${item.icon || 'bi-stars'}"></i>
                    </div>
                    <span class="insight-badge badge-${item.badge_color || 'coral'}">${item.badge || 'Insight'}</span>
                </div>
                <h4 class="insight-title">${item.title}</h4>
                <p class="insight-text">${item.text}</p>
            </div>
        </div>
    `).join("");
}

// =====================================================================
// ALL DASHBOARD CHARTS RENDERING
// =====================================================================

function renderAllCharts(analytics) {
    const theme = getThemeColors();

    // 1. Top 10 Fund Distribution Horizontal Bar Chart
    renderDistributionChart(analytics, theme);

    // 2. Fund Share Donut Chart
    renderDonutShareChart(analytics, theme);

    // 3. Top Department Allocation Summary Table
    renderDistributionSummaryTable(analytics);

    // 4. Budget Comparison Chart & Table
    renderBudgetAnalysis(analytics, theme);

    // 5. Revenue vs Capital Charts
    renderRevenueVsCapital(analytics, theme);

    // 6. Financial Trend Trajectory Chart
    renderFinancialTrends(analytics, theme);

    // 7. Departments Ranking (Top & Bottom Spending)
    renderDepartmentsRanking(analytics, theme);

    // 8. Multi-Metric Comparison Chart
    renderMetricComparison(analytics, theme);
}

// 1. Distribution Horizontal Bar Chart
function renderDistributionChart(analytics, theme) {
    const ctx = document.getElementById("top10DistChart");
    if (!ctx) return;
    destroyChart("top10DistChart");

    const top10 = analytics.departments_ranking?.top_10 || [];
    if (top10.length === 0) return;

    const labels = top10.map(d => truncateText(d.name, 26));
    const data = top10.map(d => d.amount);

    const barGradient = ctx.getContext("2d").createLinearGradient(0, 0, 400, 0);
    barGradient.addColorStop(0, "rgba(255, 87, 34, 0.95)");
    barGradient.addColorStop(1, "rgba(255, 122, 89, 0.75)");

    appState.charts["top10DistChart"] = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: barGradient,
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: theme.tooltipBg,
                    titleColor: theme.tooltipText,
                    bodyColor: theme.coral,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => top10[items[0].dataIndex].name,
                        label: (ctx) => `Allocation: ${top10[ctx.dataIndex].exact_amount} (${top10[ctx.dataIndex].percentage}%)`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: theme.gridColor },
                    ticks: {
                        color: theme.secondaryText,
                        callback: (v) => formatCompactNumber(v)
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: theme.textColor, font: { size: 11, weight: 600 } }
                }
            }
        }
    });
}

// 2. Fund Share Donut Chart
function renderDonutShareChart(analytics, theme) {
    const ctx = document.getElementById("donutShareChart");
    if (!ctx) return;
    destroyChart("donutShareChart");

    const donut = analytics.fund_distribution?.donut_chart;
    if (!donut || !donut.labels || donut.labels.length === 0) return;

    appState.charts["donutShareChart"] = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: donut.labels,
            datasets: [{
                data: donut.values,
                backgroundColor: theme.palette.slice(0, donut.labels.length),
                borderColor: theme.isDark ? "#0E131F" : "#FFFFFF",
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "65%",
            plugins: {
                legend: {
                    position: "right",
                    labels: {
                        color: theme.secondaryText,
                        boxWidth: 12,
                        padding: 12,
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    backgroundColor: theme.tooltipBg,
                    titleColor: theme.tooltipText,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => {
                            const val = ctx.parsed;
                            return ` Amount: ${val.toLocaleString()}`;
                        }
                    }
                }
            }
        }
    });
}

// 3. Distribution Summary Table
function renderDistributionSummaryTable(analytics) {
    const tbody = document.getElementById("distribution-summary-body");
    if (!tbody) return;

    const top10 = analytics.fund_distribution?.top_departments_table || [];
    if (top10.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No distribution data available</td></tr>`;
        return;
    }

    tbody.innerHTML = top10.map((dept, idx) => `
        <tr>
            <td><strong>#${idx + 1}</strong></td>
            <td><strong>${dept.name}</strong></td>
            <td>${dept.formatted_amount}</td>
            <td><span class="badge-tag">${dept.percentage}%</span></td>
            <td class="table-bar-cell">
                <div class="progress-track">
                    <div class="progress-fill" style="width: ${Math.min(100, dept.percentage * 2.5)}%;"></div>
                </div>
            </td>
        </tr>
    `).join("");
}

// 4. Budget Analysis (Actual vs BE vs RE)
function renderBudgetAnalysis(analytics, theme) {
    const section = document.getElementById("budget-section");
    const navLink = document.querySelector('a[href="#budget-section"]');
    const ctx = document.getElementById("budgetComparisonChart");
    const tbody = document.getElementById("budget-details-body");
    const budgetData = analytics.budget_analysis;

    if (!budgetData || !budgetData.has_data) {
        if (section) section.style.display = "none";
        if (navLink) navLink.style.display = "none";
        return;
    }

    if (section) section.style.display = "block";
    if (navLink) navLink.style.display = "flex";

    destroyChart("budgetComparisonChart");

    if (ctx) {
        const datasets = [
            {
                label: `Budget Estimate (${budgetData.budget_col})`,
                data: budgetData.budget_series,
                backgroundColor: "rgba(59, 130, 246, 0.85)",
                borderRadius: 4
            },
            {
                label: `Actual Expenditure (${budgetData.actual_col})`,
                data: budgetData.actual_series,
                backgroundColor: "rgba(16, 185, 129, 0.85)",
                borderRadius: 4
            }
        ];

        if (budgetData.revised_series) {
            datasets.push({
                label: `Revised Estimate (${budgetData.revised_col})`,
                data: budgetData.revised_series,
                backgroundColor: "rgba(245, 158, 11, 0.85)",
                borderRadius: 4
            });
        }

        appState.charts["budgetComparisonChart"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: budgetData.labels.map(l => truncateText(l, 20)),
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: "top",
                        labels: { color: theme.secondaryText, font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: theme.tooltipBg,
                        titleColor: theme.tooltipText,
                        borderColor: theme.tooltipBorder,
                        borderWidth: 1,
                        callbacks: {
                            title: (items) => budgetData.labels[items[0].dataIndex],
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: theme.textColor, font: { size: 10 } }
                    },
                    y: {
                        grid: { color: theme.gridColor },
                        ticks: {
                            color: theme.secondaryText,
                            callback: (v) => formatCompactNumber(v)
                        }
                    }
                }
            }
        });
    }

    // Budget Table
    if (tbody && budgetData.departments) {
        tbody.innerHTML = budgetData.departments.map(dept => {
            const isSurplus = dept.variance >= 0;
            const statusClass = isSurplus ? "text-emerald" : "text-danger";
            const statusBadge = isSurplus ? "Surplus / On Track" : "Over-Spent";
            return `
                <tr>
                    <td><strong>${dept.name}</strong></td>
                    <td>${dept.formatted_budget}</td>
                    <td>${dept.formatted_actual}</td>
                    <td>${dept.formatted_revised}</td>
                    <td class="${statusClass}"><strong>${dept.formatted_variance}</strong></td>
                    <td><span class="badge-tag">${dept.utilization}%</span></td>
                    <td><span class="insight-badge ${isSurplus ? 'badge-emerald' : 'badge-coral'}">${statusBadge}</span></td>
                </tr>
            `;
        }).join("");
    }
}

// 5. Revenue vs Capital
function renderRevenueVsCapital(analytics, theme) {
    const section = document.getElementById("rev-cap-section");
    const navLink = document.getElementById("nav-rev-cap");
    const donutCtx = document.getElementById("revCapDonutChart");
    const barCtx = document.getElementById("revCapBarChart");
    const revCap = analytics.revenue_vs_capital;

    if (!revCap || !revCap.has_data) {
        if (section) section.style.display = "none";
        if (navLink) navLink.style.display = "none";
        return;
    }

    if (section) section.style.display = "block";
    if (navLink) navLink.style.display = "flex";

    // Update Quick Stats
    setText("rev-cap-stat-rev", revCap.formatted_revenue);
    setText("rev-cap-stat-rev-pct", `${revCap.revenue_percentage}%`);
    setText("rev-cap-stat-cap", revCap.formatted_capital);
    setText("rev-cap-stat-cap-pct", `${revCap.capital_percentage}%`);

    destroyChart("revCapDonutChart");
    destroyChart("revCapBarChart");

    // Donut
    if (donutCtx) {
        appState.charts["revCapDonutChart"] = new Chart(donutCtx, {
            type: "doughnut",
            data: {
                labels: [`Revenue (${revCap.revenue_percentage}%)`, `Capital (${revCap.capital_percentage}%)`],
                datasets: [{
                    data: [revCap.total_revenue, revCap.total_capital],
                    backgroundColor: [theme.coral, theme.cyan],
                    borderColor: theme.isDark ? "#0E131F" : "#FFFFFF",
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "60%",
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: { color: theme.secondaryText, font: { size: 11 } }
                    }
                }
            }
        });
    }

    // Bar chart
    if (barCtx && revCap.chart_labels) {
        appState.charts["revCapBarChart"] = new Chart(barCtx, {
            type: "bar",
            data: {
                labels: revCap.chart_labels.map(l => truncateText(l, 18)),
                datasets: [
                    {
                        label: "Revenue Outlay",
                        data: revCap.revenue_values,
                        backgroundColor: theme.coral,
                        borderRadius: 4
                    },
                    {
                        label: "Capital Outlay",
                        data: revCap.capital_values,
                        backgroundColor: theme.cyan,
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: "top",
                        labels: { color: theme.secondaryText, font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: theme.tooltipBg,
                        titleColor: theme.tooltipText,
                        callbacks: {
                            title: (items) => revCap.chart_labels[items[0].dataIndex]
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: theme.textColor, font: { size: 10 } }
                    },
                    y: {
                        grid: { color: theme.gridColor },
                        ticks: {
                            color: theme.secondaryText,
                            callback: (v) => formatCompactNumber(v)
                        }
                    }
                }
            }
        });
    }
}

// 6. Financial Trend Analysis
function renderFinancialTrends(analytics, theme) {
    const section = document.getElementById("trend-section");
    const ctx = document.getElementById("financialTrendChart");
    const yearData = analytics.year_analysis;

    if (!yearData || !yearData.has_data) {
        if (section) section.style.display = "none";
        return;
    }

    if (section) section.style.display = "block";
    destroyChart("financialTrendChart");

    if (ctx) {
        const trendGradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 300);
        trendGradient.addColorStop(0, "rgba(255, 87, 34, 0.45)");
        trendGradient.addColorStop(1, "rgba(255, 87, 34, 0)");

        appState.charts["financialTrendChart"] = new Chart(ctx, {
            type: "line",
            data: {
                labels: yearData.labels,
                datasets: [{
                    label: yearData.metric_name || "Total Public Outlay",
                    data: yearData.values,
                    borderColor: theme.coral,
                    backgroundColor: trendGradient,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 3,
                    pointBackgroundColor: theme.coral,
                    pointBorderColor: "#FFFFFF",
                    pointRadius: 6,
                    pointHoverRadius: 9
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: "top",
                        labels: { color: theme.secondaryText, font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: theme.tooltipBg,
                        titleColor: theme.tooltipText,
                        callbacks: {
                            label: (ctx) => ` Amount: ${ctx.parsed.y.toLocaleString()}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: theme.gridColor },
                        ticks: { color: theme.textColor, font: { size: 11, weight: 600 } }
                    },
                    y: {
                        grid: { color: theme.gridColor },
                        ticks: {
                            color: theme.secondaryText,
                            callback: (v) => formatCompactNumber(v)
                        }
                    }
                }
            }
        });
    }
}

// 7. Departments Ranking (Top & Bottom Spending)
function renderDepartmentsRanking(analytics, theme) {
    const ranking = analytics.departments_ranking || {};
    const top10 = ranking.top_10 || [];
    const bottom10 = ranking.bottom_10 || [];
    const showBottom = ranking.show_bottom_10;

    // Top 10 Spending
    const topCtx = document.getElementById("topSpendingChart");
    if (topCtx && top10.length > 0) {
        destroyChart("topSpendingChart");
        appState.charts["topSpendingChart"] = new Chart(topCtx, {
            type: "bar",
            data: {
                labels: top10.map(d => truncateText(d.name, 22)),
                datasets: [{
                    label: "Allocation",
                    data: top10.map(d => d.amount),
                    backgroundColor: "rgba(16, 185, 129, 0.8)",
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: theme.tooltipBg,
                        titleColor: theme.tooltipText,
                        callbacks: {
                            title: (items) => top10[items[0].dataIndex].name,
                            label: (ctx) => `Outlay: ${top10[ctx.dataIndex].exact_amount}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: theme.gridColor },
                        ticks: { color: theme.secondaryText, callback: (v) => formatCompactNumber(v) }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: theme.textColor, font: { size: 10 } }
                    }
                }
            }
        });
    }

    // Lowest 10 Spending (Conditional)
    const bottomCard = document.getElementById("lowest-spending-card");
    const bottomCtx = document.getElementById("lowestSpendingChart");

    if (!showBottom || bottom10.length === 0) {
        if (bottomCard) bottomCard.style.display = "none";
    } else {
        if (bottomCard) bottomCard.style.display = "block";
        destroyChart("lowestSpendingChart");
        if (bottomCtx) {
            appState.charts["lowestSpendingChart"] = new Chart(bottomCtx, {
                type: "bar",
                data: {
                    labels: bottom10.map(d => truncateText(d.name, 22)),
                    datasets: [{
                        label: "Allocation",
                        data: bottom10.map(d => d.amount),
                        backgroundColor: "rgba(245, 158, 11, 0.8)",
                        borderRadius: 4
                    }]
                },
                options: {
                    indexAxis: "y",
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            callbacks: {
                                title: (items) => bottom10[items[0].dataIndex].name,
                                label: (ctx) => `Outlay: ${bottom10[ctx.dataIndex].exact_amount}`
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { color: theme.gridColor },
                            ticks: { color: theme.secondaryText, callback: (v) => formatCompactNumber(v) }
                        },
                        y: {
                            grid: { display: false },
                            ticks: { color: theme.textColor, font: { size: 10 } }
                        }
                    }
                }
            });
        }
    }
}

// 8. Multi-Metric Comparison
function renderMetricComparison(analytics, theme) {
    const section = document.getElementById("comparison-section");
    const ctx = document.getElementById("comparisonChart");
    const comp = analytics.comparison_analysis;

    if (!comp || !comp.has_data || comp.datasets.length < 2) {
        if (section) section.style.display = "none";
        return;
    }

    if (section) section.style.display = "block";
    destroyChart("comparisonChart");

    if (ctx) {
        const colors = [theme.coral, theme.blue, theme.emerald, theme.purple];
        const chartDatasets = comp.datasets.map((d, i) => ({
            label: d.label,
            data: d.values,
            backgroundColor: colors[i % colors.length],
            borderRadius: 4
        }));

        appState.charts["comparisonChart"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: comp.labels.map(l => truncateText(l, 20)),
                datasets: chartDatasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: "top",
                        labels: { color: theme.secondaryText, font: { size: 11 } }
                    },
                    tooltip: {
                        backgroundColor: theme.tooltipBg,
                        titleColor: theme.tooltipText,
                        callbacks: {
                            title: (items) => comp.labels[items[0].dataIndex]
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: theme.textColor, font: { size: 10 } }
                    },
                    y: {
                        grid: { color: theme.gridColor },
                        ticks: {
                            color: theme.secondaryText,
                            callback: (v) => formatCompactNumber(v)
                        }
                    }
                }
            }
        });
    }
}

// =====================================================================
// DATA TABLE LOGIC & PAGINATION
// =====================================================================

async function fetchTableData() {
    const params = new URLSearchParams({
        page: appState.tablePage,
        page_size: appState.tablePageSize,
        search: appState.tableSearch
    });

    if (appState.tableSortBy) {
        params.append("sort_by", appState.tableSortBy);
        params.append("sort_order", appState.tableSortOrder);
    }

    if (appState.activeDepartment && appState.activeDepartment !== "ALL") {
        params.append("department", appState.activeDepartment);
    }

    try {
        const response = await fetch(`/data?${params.toString()}`);
        const data = await response.json();

        if (data.success) {
            renderMainTable(data);
        }
    } catch (err) {
        console.error("Table fetch error:", err);
    }
}

function renderMainTable(data) {
    const thead = document.getElementById("main-table-head");
    const tbody = document.getElementById("main-table-body");
    const paginationInfo = document.getElementById("pagination-info");
    const paginationControls = document.getElementById("pagination-controls");

    if (!thead || !tbody) return;

    // Render Headers with sort indicators
    thead.innerHTML = `<tr>${data.columns.map(col => {
        let sortIcon = '<i class="bi bi-arrow-down-up sort-icon"></i>';
        if (appState.tableSortBy === col.name) {
            sortIcon = appState.tableSortOrder === "asc"
                ? '<i class="bi bi-arrow-up-short sort-icon text-coral"></i>'
                : '<i class="bi bi-arrow-down-short sort-icon text-coral"></i>';
        }
        return `<th onclick="sortTableBy('${col.name}')">${col.name} ${sortIcon}</th>`;
    }).join("")}</tr>`;

    // Render Rows
    if (!data.rows || data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${data.columns.length}" class="text-center text-muted py-4">No records matched your query</td></tr>`;
    } else {
        tbody.innerHTML = data.rows.map(row => `
            <tr>${data.columns.map(col => {
                const val = row[col.name];
                let displayVal = val !== undefined && val !== null ? val : "-";
                if (col.is_numeric && typeof val === "number") {
                    displayVal = val.toLocaleString();
                }
                return `<td>${displayVal}</td>`;
            }).join("")}</tr>
        `).join("");
    }

    // Pagination info
    const start = data.filtered_rows === 0 ? 0 : (data.page - 1) * data.page_size + 1;
    const end = Math.min(data.page * data.page_size, data.filtered_rows);
    if (paginationInfo) {
        paginationInfo.textContent = `Showing ${start} to ${end} of ${data.filtered_rows} records (Total ${data.total_rows})`;
    }

    // Pagination controls
    if (paginationControls) {
        let btns = [];
        btns.push(`<button class="page-btn" ${data.page <= 1 ? 'disabled' : ''} onclick="changeTablePage(${data.page - 1})"><i class="bi bi-chevron-left"></i></button>`);

        // Show window of page numbers
        const totalPages = data.total_pages;
        let startPage = Math.max(1, data.page - 2);
        let endPage = Math.min(totalPages, startPage + 4);
        if (endPage - startPage < 4) {
            startPage = Math.max(1, endPage - 4);
        }

        for (let p = startPage; p <= endPage; p++) {
            btns.push(`<button class="page-btn ${p === data.page ? 'active' : ''}" onclick="changeTablePage(${p})">${p}</button>`);
        }

        btns.push(`<button class="page-btn" ${data.page >= totalPages ? 'disabled' : ''} onclick="changeTablePage(${data.page + 1})"><i class="bi bi-chevron-right"></i></button>`);
        paginationControls.innerHTML = btns.join("");
    }
}

window.changeTablePage = function(p) {
    appState.tablePage = p;
    fetchTableData();
};

window.sortTableBy = function(colName) {
    if (appState.tableSortBy === colName) {
        appState.tableSortOrder = appState.tableSortOrder === "asc" ? "desc" : "asc";
    } else {
        appState.tableSortBy = colName;
        appState.tableSortOrder = "asc";
    }
    appState.tablePage = 1;
    fetchTableData();
};

// =====================================================================
// DATA QUALITY RENDERING
// =====================================================================

function renderDataQuality(quality) {
    if (!quality) return;

    setText("quality-score-value", `${quality.quality_score}%`);
    setText("dq-rows", quality.total_rows);
    setText("dq-cols", quality.total_cols);
    setText("dq-missing", quality.missing_cells);
    setText("dq-missing-pct", `(${quality.missing_percentage}% of total cells)`);
    setText("dq-duplicates", quality.duplicate_rows);
    setText("dq-numeric", quality.numeric_columns_count);
    setText("dq-text", quality.text_columns_count);
    setText("dq-empty", quality.empty_columns.length > 0 ? quality.empty_columns.join(", ") : "None");

    const tbody = document.getElementById("quality-columns-body");
    if (tbody && quality.columns_breakdown) {
        tbody.innerHTML = quality.columns_breakdown.map(col => {
            const completeness = Math.max(0, 100 - col.missing_pct);
            return `
                <tr>
                    <td><strong>${col.name}</strong></td>
                    <td><span class="badge-tag">${col.type}</span></td>
                    <td>${col.missing_count}</td>
                    <td>${col.missing_pct}%</td>
                    <td>${col.distinct_count}</td>
                    <td class="table-bar-cell">
                        <div class="progress-track">
                            <div class="progress-fill" style="width: ${completeness}%;"></div>
                        </div>
                    </td>
                </tr>
            `;
        }).join("");
    }
}

// =====================================================================
// CHART DOWNLOAD UTILITY
// =====================================================================

function downloadChartAsImage(chartId) {
    const chart = appState.charts[chartId];
    if (!chart) {
        showToast("Chart is not ready for download.", "error");
        return;
    }

    const a = document.createElement("a");
    a.href = chart.toBase64Image();
    a.download = `${chartId}_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    showToast("Chart image downloaded successfully.", "success");
}

// =====================================================================
// HELPER FORMATTING FUNCTIONS
// =====================================================================

function formatCompactNumber(number) {
    if (number === null || number === undefined || isNaN(number)) return "0";
    const abs = Math.abs(number);
    const sign = number < 0 ? "-" : "";
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
    return `${sign}${number}`;
}

function truncateText(str, maxLen) {
    if (!str) return "";
    return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}
