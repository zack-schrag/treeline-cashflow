<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PluginSDK } from "./types";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();

  // Types
  interface RecurringTransaction {
    description: string;
    merchant_key: string;
    amount: number; // Negative for expenses, positive for income
    frequency: string;
    interval_days: number;
    occurrence_count: number;
    last_date: string;
    next_date: string;
    is_income: boolean;
    is_hidden: boolean;
  }

  interface ProjectedDay {
    date: string;
    balance: number;
    transactions: { description: string; amount: number }[];
    is_danger: boolean;
  }

  // State
  let recurringTransactions = $state<RecurringTransaction[]>([]);
  let hiddenKeys = $state<Set<string>>(new Set());
  let currentBalance = $state(0);
  let projections = $state<ProjectedDay[]>([]);
  let isLoading = $state(true);
  let horizonDays = $state(60);
  let dangerThreshold = $state(0);
  let cursorIndex = $state(0);
  let showHidden = $state(false);

  // Refs
  let containerEl = $state<HTMLDivElement | null>(null);

  // Computed
  let visibleTransactions = $derived(
    recurringTransactions.filter(t => showHidden || !t.is_hidden)
  );

  let incomeTransactions = $derived(
    visibleTransactions.filter(t => t.is_income && !t.is_hidden)
  );

  let expenseTransactions = $derived(
    visibleTransactions.filter(t => !t.is_income && !t.is_hidden)
  );

  let monthlyIncome = $derived(
    incomeTransactions.reduce((sum, t) => sum + (t.amount * 30 / t.interval_days), 0)
  );

  let monthlyExpenses = $derived(
    expenseTransactions.reduce((sum, t) => sum + (Math.abs(t.amount) * 30 / t.interval_days), 0)
  );

  let monthlyNet = $derived(monthlyIncome - monthlyExpenses);

  let projectedBalance = $derived(
    projections.length > 0 ? projections[projections.length - 1].balance : currentBalance
  );

  let lowestBalance = $derived(
    projections.length > 0 ? Math.min(...projections.map(p => p.balance)) : currentBalance
  );

  let dangerDate = $derived(() => {
    const danger = projections.find(p => p.balance < dangerThreshold);
    return danger?.date || null;
  });

  let upcomingTransactions = $derived(
    projections
      .flatMap(p => p.transactions.map(t => ({ ...t, date: p.date })))
      .slice(0, 15)
  );

  let selectedTransaction = $derived(
    cursorIndex < visibleTransactions.length ? visibleTransactions[cursorIndex] : null
  );

  // Lifecycle
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    unsubscribe = sdk.onDataRefresh(() => {
      loadData();
    });

    await ensureTables();
    await loadSettings();
    await loadHiddenKeys();
    await loadData();

    containerEl?.focus();
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Database
  async function ensureTables() {
    try {
      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_treeline_cashflow_hidden (
          merchant_key VARCHAR PRIMARY KEY,
          hidden_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_treeline_cashflow_scheduled (
          id VARCHAR PRIMARY KEY,
          description VARCHAR NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          frequency VARCHAR NOT NULL,
          next_date DATE NOT NULL,
          end_date DATE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (e) {
      // Tables may already exist
    }
  }

  async function loadSettings() {
    try {
      const savedHorizon = await sdk.settings.get("horizonDays");
      if (savedHorizon && typeof savedHorizon === "number") {
        horizonDays = savedHorizon;
      }
      const savedThreshold = await sdk.settings.get("dangerThreshold");
      if (savedThreshold && typeof savedThreshold === "number") {
        dangerThreshold = savedThreshold;
      }
    } catch (e) {
      // Use defaults
    }
  }

  async function loadHiddenKeys() {
    try {
      const rows = await sdk.query<any>(
        "SELECT merchant_key FROM sys_plugin_treeline_cashflow_hidden"
      );
      hiddenKeys = new Set(rows.map((r: any) => r[0] as string).filter(Boolean));
    } catch (e) {
      // Table might not exist yet
    }
  }

  // SQL for detecting recurring transactions (income + expenses)
  const RECURRING_SQL = `WITH base_transactions AS (
  SELECT
    ROUND(amount, 2) as norm_amount,
    UPPER(description) as upper_desc,
    description,
    amount,
    transaction_date
  FROM transactions
  WHERE description IS NOT NULL
    AND description != ''
),
canonical_merchants AS (
  SELECT DISTINCT ON (norm_amount)
    norm_amount,
    upper_desc as canonical_desc
  FROM base_transactions
  ORDER BY norm_amount, transaction_date ASC
),
grouped_transactions AS (
  SELECT
    b.norm_amount,
    b.description,
    b.amount,
    b.transaction_date,
    CASE
      WHEN jaro_winkler_similarity(b.upper_desc, c.canonical_desc) > 0.7
      THEN c.canonical_desc
      ELSE b.upper_desc
    END as merchant_group
  FROM base_transactions b
  LEFT JOIN canonical_merchants c ON b.norm_amount = c.norm_amount
),
merchant_transactions AS (
  SELECT
    merchant_group,
    norm_amount,
    description as merchant,
    amount,
    transaction_date,
    LAG(transaction_date) OVER (
      PARTITION BY merchant_group, norm_amount
      ORDER BY transaction_date
    ) as prev_date
  FROM grouped_transactions
),
merchant_intervals AS (
  SELECT
    merchant_group,
    norm_amount,
    merchant,
    amount,
    transaction_date,
    DATEDIFF('day', prev_date, transaction_date) as interval_days
  FROM merchant_transactions
  WHERE prev_date IS NOT NULL
),
merchant_stats AS (
  SELECT
    FIRST(mi.merchant) as description,
    mi.merchant_group as merchant_key,
    AVG(mi.amount) as avg_amount,
    COUNT(*) + 1 as occurrence_count,
    AVG(mi.interval_days) as avg_interval,
    STDDEV(mi.interval_days) as stddev_interval,
    MAX(mi.transaction_date) as last_date,
    DATEDIFF('day', MAX(mi.transaction_date), CURRENT_DATE) as days_since_last
  FROM merchant_intervals mi
  GROUP BY mi.merchant_group, mi.norm_amount
  HAVING
    COUNT(*) >= 2
    AND AVG(mi.interval_days) BETWEEN 5 AND 400
    AND STDDEV(mi.interval_days) < AVG(mi.interval_days) * 0.5
)
SELECT
  description,
  merchant_key,
  avg_amount,
  occurrence_count,
  avg_interval,
  last_date,
  days_since_last
FROM merchant_stats
ORDER BY ABS(avg_amount) DESC`;

  async function loadData() {
    isLoading = true;
    try {
      // Get current total balance
      const balanceRows = await sdk.query<any>(
        "SELECT COALESCE(SUM(balance), 0) as total FROM sys_accounts"
      );
      currentBalance = Math.round((balanceRows[0]?.[0] as number || 0) * 100) / 100;

      // Load recurring transactions
      const rows = await sdk.query<any>(RECURRING_SQL);

      recurringTransactions = rows.map((row: any) => {
        const description = row[0] as string || "";
        const merchant_key = row[1] as string || description.toUpperCase();
        const avg_amount = row[2] as number;
        const occurrence_count = row[3] as number;
        const avg_interval = row[4] as number;
        const last_date = row[5] as string;
        const days_since_last = row[6] as number;

        const interval_days = Math.round(avg_interval);
        let frequency = "monthly";
        if (interval_days <= 8) frequency = "weekly";
        else if (interval_days <= 16) frequency = "biweekly";
        else if (interval_days <= 35) frequency = "monthly";
        else if (interval_days <= 100) frequency = "quarterly";
        else frequency = "annual";

        // Calculate next expected date
        const lastDateObj = new Date(last_date);
        const nextDateObj = new Date(lastDateObj);
        nextDateObj.setDate(nextDateObj.getDate() + interval_days);

        // If next date is in the past, move forward
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        while (nextDateObj < today) {
          nextDateObj.setDate(nextDateObj.getDate() + interval_days);
        }

        return {
          description,
          merchant_key,
          amount: Math.round(avg_amount * 100) / 100,
          frequency,
          interval_days,
          occurrence_count,
          last_date,
          next_date: nextDateObj.toISOString().split('T')[0],
          is_income: avg_amount > 0,
          is_hidden: hiddenKeys.has(merchant_key),
        };
      });

      // Generate projections
      generateProjections();
    } catch (e) {
      sdk.toast.error("Failed to load data", e instanceof Error ? e.message : String(e));
    } finally {
      isLoading = false;
    }
  }

  function generateProjections() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let balance = currentBalance;
    const days: ProjectedDay[] = [];

    // Get active (non-hidden) recurring transactions
    const activeRecurring = recurringTransactions.filter(t => !hiddenKeys.has(t.merchant_key));

    for (let i = 0; i <= horizonDays; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];

      // Find transactions occurring on this day
      const dayTransactions: { description: string; amount: number }[] = [];

      for (const txn of activeRecurring) {
        const nextDate = new Date(txn.next_date);
        nextDate.setHours(0, 0, 0, 0);

        // Check if this transaction occurs on this day
        let checkDate = new Date(nextDate);
        while (checkDate <= date) {
          if (checkDate.toISOString().split('T')[0] === dateStr) {
            dayTransactions.push({
              description: txn.description,
              amount: txn.amount,
            });
            break;
          }
          checkDate.setDate(checkDate.getDate() + txn.interval_days);
        }
      }

      // Update balance
      const dayTotal = dayTransactions.reduce((sum, t) => sum + t.amount, 0);
      balance = Math.round((balance + dayTotal) * 100) / 100;

      days.push({
        date: dateStr,
        balance,
        transactions: dayTransactions,
        is_danger: balance < dangerThreshold,
      });
    }

    projections = days;
  }

  // Actions
  async function hideTransaction(txn: RecurringTransaction) {
    try {
      const escaped = txn.merchant_key.replace(/'/g, "''");
      await sdk.execute(`
        INSERT INTO sys_plugin_treeline_cashflow_hidden (merchant_key, hidden_at)
        VALUES ('${escaped}', CURRENT_TIMESTAMP)
        ON CONFLICT (merchant_key) DO UPDATE SET hidden_at = CURRENT_TIMESTAMP
      `);
      hiddenKeys = new Set([...hiddenKeys, txn.merchant_key]);
      // Update the transaction in place
      recurringTransactions = recurringTransactions.map(t =>
        t.merchant_key === txn.merchant_key ? { ...t, is_hidden: true } : t
      );
      generateProjections();
      sdk.toast.info("Hidden", `"${txn.description}" excluded from projections`);
    } catch (e) {
      sdk.toast.error("Failed to hide", e instanceof Error ? e.message : String(e));
    }
  }

  async function unhideTransaction(txn: RecurringTransaction) {
    try {
      const escaped = txn.merchant_key.replace(/'/g, "''");
      await sdk.execute(`
        DELETE FROM sys_plugin_treeline_cashflow_hidden WHERE merchant_key = '${escaped}'
      `);
      const newHidden = new Set(hiddenKeys);
      newHidden.delete(txn.merchant_key);
      hiddenKeys = newHidden;
      recurringTransactions = recurringTransactions.map(t =>
        t.merchant_key === txn.merchant_key ? { ...t, is_hidden: false } : t
      );
      generateProjections();
      sdk.toast.info("Restored", `"${txn.description}" included in projections`);
    } catch (e) {
      sdk.toast.error("Failed to restore", e instanceof Error ? e.message : String(e));
    }
  }

  async function setHorizon(days: number) {
    horizonDays = days;
    await sdk.settings.set("horizonDays", days);
    generateProjections();
  }

  function viewSQL() {
    sdk.openView("query", { initialQuery: RECURRING_SQL });
  }

  function viewTransactions(description: string) {
    const escaped = description.replace(/'/g, "''");
    sdk.openView("query", {
      initialQuery: `SELECT transaction_date, description, amount
FROM transactions
WHERE description = '${escaped}'
ORDER BY transaction_date DESC`
    });
  }

  // Formatting
  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  }

  function formatCurrencyPrecise(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  function formatDateFull(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  // Keyboard navigation
  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        cursorIndex = Math.min(cursorIndex + 1, visibleTransactions.length - 1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        cursorIndex = Math.max(cursorIndex - 1, 0);
        break;
      case "Enter":
        if (selectedTransaction) {
          e.preventDefault();
          viewTransactions(selectedTransaction.description);
        }
        break;
      case "h":
        if (selectedTransaction) {
          e.preventDefault();
          if (selectedTransaction.is_hidden) {
            unhideTransaction(selectedTransaction);
          } else {
            hideTransaction(selectedTransaction);
          }
        }
        break;
      case "1":
        e.preventDefault();
        setHorizon(30);
        break;
      case "2":
        e.preventDefault();
        setHorizon(60);
        break;
      case "3":
        e.preventDefault();
        setHorizon(90);
        break;
    }
  }

  // Keep cursor in bounds
  $effect(() => {
    if (cursorIndex >= visibleTransactions.length) {
      cursorIndex = Math.max(0, visibleTransactions.length - 1);
    }
  });

  // Regenerate projections when hidden keys change
  $effect(() => {
    if (!isLoading && recurringTransactions.length > 0) {
      generateProjections();
    }
  });
</script>

<div
  class="cashflow-view"
  bind:this={containerEl}
  onkeydown={handleKeyDown}
  tabindex="-1"
  role="application"
>
  <!-- Header -->
  <header class="header">
    <div class="title-row">
      <h1 class="title">Cash Flow</h1>
      {#if !isLoading}
        <span class="count-badge">{incomeTransactions.length} income</span>
        <span class="count-badge expense">{expenseTransactions.length} expenses</span>
        {#if hiddenKeys.size > 0}
          <span class="hidden-badge">{hiddenKeys.size} hidden</span>
        {/if}
      {/if}
      <div class="header-spacer"></div>
      <button class="sql-link" onclick={viewSQL}>View SQL</button>
      <button class="refresh-btn" onclick={() => loadData()} disabled={isLoading}>
        Refresh
      </button>
    </div>

    {#if !isLoading && recurringTransactions.length > 0}
      <div class="hero-cards">
        <div class="hero-card">
          <span class="hero-label">Current Balance</span>
          <span class="hero-value">{formatCurrency(currentBalance)}</span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Projected ({horizonDays}d)</span>
          <span class="hero-value" class:danger={projectedBalance < dangerThreshold}>
            {formatCurrency(projectedBalance)}
          </span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Lowest Point</span>
          <span class="hero-value" class:danger={lowestBalance < dangerThreshold}>
            {formatCurrency(lowestBalance)}
          </span>
        </div>
        <div class="hero-card">
          <span class="hero-label">Monthly Net</span>
          <span class="hero-value" class:positive={monthlyNet > 0} class:negative={monthlyNet < 0}>
            {monthlyNet >= 0 ? '+' : ''}{formatCurrency(monthlyNet)}
          </span>
        </div>
      </div>

      <div class="horizon-selector">
        <span class="horizon-label">Horizon:</span>
        <button class:active={horizonDays === 30} onclick={() => setHorizon(30)}>30d</button>
        <button class:active={horizonDays === 60} onclick={() => setHorizon(60)}>60d</button>
        <button class:active={horizonDays === 90} onclick={() => setHorizon(90)}>90d</button>
      </div>
    {/if}
  </header>

  <!-- Main Content -->
  <div class="main-content">
    {#if isLoading}
      <div class="loading">
        <div class="spinner"></div>
        <span>Analyzing transactions...</span>
      </div>
    {:else if recurringTransactions.length === 0}
      <div class="empty">
        <p class="empty-message">No recurring transactions detected.</p>
        <p class="empty-hint">Cash flow projections require regular income/expense patterns (3+ occurrences).</p>
      </div>
    {:else}
      <div class="split-view">
        <!-- Left: Upcoming Transactions -->
        <div class="upcoming-section">
          <h2 class="section-title">Upcoming Transactions</h2>
          {#if upcomingTransactions.length === 0}
            <p class="empty-hint">No upcoming transactions in the next {horizonDays} days</p>
          {:else}
            <div class="upcoming-list">
              {#each upcomingTransactions as txn}
                <div class="upcoming-item" class:income={txn.amount > 0}>
                  <span class="upcoming-date">{formatDateFull(txn.date)}</span>
                  <span class="upcoming-desc">{txn.description}</span>
                  <span class="upcoming-amount" class:positive={txn.amount > 0}>
                    {txn.amount > 0 ? '+' : ''}{formatCurrencyPrecise(txn.amount)}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Right: Recurring Items -->
        <div class="recurring-section">
          <div class="section-header">
            <h2 class="section-title">Detected Recurring</h2>
            <button
              class="toggle-hidden"
              class:active={showHidden}
              onclick={() => showHidden = !showHidden}
            >
              {showHidden ? 'Hide hidden' : 'Show hidden'}
            </button>
          </div>

          <div class="recurring-list">
            {#each visibleTransactions as txn, i}
              <div
                class="recurring-item"
                class:selected={i === cursorIndex}
                class:hidden={txn.is_hidden}
                class:income={txn.is_income}
                onclick={() => cursorIndex = i}
                ondblclick={() => viewTransactions(txn.description)}
              >
                <div class="recurring-main">
                  <span class="recurring-desc">{txn.description}</span>
                  <span class="recurring-freq">{txn.frequency}</span>
                </div>
                <div class="recurring-meta">
                  <span class="recurring-amount" class:positive={txn.is_income}>
                    {txn.is_income ? '+' : ''}{formatCurrencyPrecise(txn.amount)}
                  </span>
                  <span class="recurring-next">Next: {formatDate(txn.next_date)}</span>
                </div>
                {#if i === cursorIndex}
                  <div class="recurring-actions">
                    {#if txn.is_hidden}
                      <button onclick={() => unhideTransaction(txn)}>Restore</button>
                    {:else}
                      <button onclick={() => hideTransaction(txn)}>Hide</button>
                    {/if}
                    <button onclick={() => viewTransactions(txn.description)}>View</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </div>

      <!-- Balance Timeline -->
      <div class="timeline-section">
        <h2 class="section-title">Balance Timeline</h2>
        <div class="timeline">
          {#each projections.filter((_, i) => i % Math.ceil(horizonDays / 10) === 0 || i === projections.length - 1) as day}
            <div class="timeline-point" class:danger={day.is_danger}>
              <span class="timeline-date">{formatDate(day.date)}</span>
              <span class="timeline-balance">{formatCurrency(day.balance)}</span>
              {#if day.transactions.length > 0}
                <span class="timeline-txns">
                  {day.transactions.length} txn{day.transactions.length > 1 ? 's' : ''}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Keyboard Hints -->
  <footer class="keyboard-hints">
    <span class="hint"><kbd>j</kbd><kbd>k</kbd> nav</span>
    <span class="hint"><kbd>Enter</kbd> view txns</span>
    <span class="hint"><kbd>h</kbd> hide/restore</span>
    <span class="hint"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> horizon</span>
  </footer>
</div>

<style>
  .cashflow-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    outline: none;
  }

  /* Header */
  .header {
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 12px);
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .count-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-success, #3fb950);
    padding: 2px 8px;
    background: rgba(63, 185, 80, 0.1);
    border-radius: 10px;
  }

  .count-badge.expense {
    color: var(--accent-danger, #f85149);
    background: rgba(248, 81, 73, 0.1);
  }

  .hidden-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border-radius: 10px;
  }

  .header-spacer {
    flex: 1;
  }

  .sql-link, .refresh-btn {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .sql-link:hover, .refresh-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Hero Cards */
  .hero-cards {
    display: flex;
    gap: var(--spacing-md, 12px);
    margin-top: var(--spacing-md, 12px);
  }

  .hero-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hero-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .hero-value {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }

  .hero-value.positive {
    color: var(--accent-success, #3fb950);
  }

  .hero-value.negative {
    color: var(--accent-danger, #f85149);
  }

  .hero-value.danger {
    color: var(--accent-danger, #f85149);
  }

  /* Horizon Selector */
  .horizon-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    margin-top: var(--spacing-sm, 8px);
  }

  .horizon-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .horizon-selector button {
    padding: 4px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .horizon-selector button:hover {
    background: var(--bg-secondary);
  }

  .horizon-selector button.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: white;
  }

  /* Main Content */
  .main-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .loading, .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    gap: var(--spacing-md, 12px);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-primary);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .empty-message {
    font-size: 14px;
    margin: 0;
  }

  .empty-hint {
    font-size: 12px;
    margin: 0;
    color: var(--text-muted);
  }

  /* Split View */
  .split-view {
    flex: 1;
    display: flex;
    overflow: hidden;
    border-bottom: 1px solid var(--border-primary);
  }

  .upcoming-section, .recurring-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .recurring-section {
    border-left: 1px solid var(--border-primary);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .section-header .section-title {
    padding: 0;
    border-bottom: none;
    background: none;
  }

  .toggle-hidden {
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 10px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .toggle-hidden:hover, .toggle-hidden.active {
    color: var(--text-primary);
  }

  /* Upcoming List */
  .upcoming-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--spacing-sm, 8px);
  }

  .upcoming-item {
    display: grid;
    grid-template-columns: 80px 1fr auto;
    gap: var(--spacing-sm, 8px);
    padding: var(--spacing-sm, 8px);
    border-bottom: 1px solid var(--border-primary);
    font-size: 13px;
  }

  .upcoming-item.income {
    background: rgba(63, 185, 80, 0.05);
  }

  .upcoming-date {
    color: var(--text-muted);
    font-size: 11px;
  }

  .upcoming-desc {
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .upcoming-amount {
    font-family: var(--font-mono, monospace);
    color: var(--accent-danger, #f85149);
  }

  .upcoming-amount.positive {
    color: var(--accent-success, #3fb950);
  }

  /* Recurring List */
  .recurring-list {
    flex: 1;
    overflow-y: auto;
  }

  .recurring-item {
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    border-bottom: 1px solid var(--border-primary);
    cursor: pointer;
  }

  .recurring-item:hover {
    background: var(--bg-secondary);
  }

  .recurring-item.selected {
    background: var(--bg-active, rgba(88, 166, 255, 0.1));
  }

  .recurring-item.hidden {
    opacity: 0.5;
  }

  .recurring-item.income {
    border-left: 3px solid var(--accent-success, #3fb950);
  }

  .recurring-item:not(.income) {
    border-left: 3px solid var(--accent-danger, #f85149);
  }

  .recurring-main {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .recurring-desc {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .recurring-freq {
    font-size: 10px;
    color: var(--accent-primary);
    background: var(--bg-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .recurring-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 4px;
  }

  .recurring-amount {
    font-size: 12px;
    font-family: var(--font-mono, monospace);
    color: var(--accent-danger, #f85149);
  }

  .recurring-amount.positive {
    color: var(--accent-success, #3fb950);
  }

  .recurring-next {
    font-size: 11px;
    color: var(--text-muted);
  }

  .recurring-actions {
    display: flex;
    gap: var(--spacing-sm, 8px);
    margin-top: var(--spacing-sm, 8px);
  }

  .recurring-actions button {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .recurring-actions button:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  /* Timeline */
  .timeline-section {
    padding: var(--spacing-md, 12px);
    background: var(--bg-secondary);
  }

  .timeline-section .section-title {
    padding: 0 0 var(--spacing-sm, 8px) 0;
    background: none;
    border-bottom: none;
  }

  .timeline {
    display: flex;
    gap: var(--spacing-md, 12px);
    overflow-x: auto;
    padding: var(--spacing-sm, 8px) 0;
  }

  .timeline-point {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--spacing-sm, 8px);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    min-width: 80px;
  }

  .timeline-point.danger {
    border-color: var(--accent-danger, #f85149);
    background: rgba(248, 81, 73, 0.1);
  }

  .timeline-date {
    font-size: 10px;
    color: var(--text-muted);
  }

  .timeline-balance {
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    color: var(--text-primary);
  }

  .timeline-point.danger .timeline-balance {
    color: var(--accent-danger, #f85149);
  }

  .timeline-txns {
    font-size: 9px;
    color: var(--text-muted);
  }

  /* Keyboard Hints */
  .keyboard-hints {
    display: flex;
    align-items: center;
    gap: var(--spacing-lg, 16px);
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-primary);
    font-size: 11px;
    color: var(--text-muted);
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .hint kbd {
    display: inline-block;
    padding: 2px 5px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 3px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
  }
</style>
