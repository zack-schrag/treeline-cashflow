<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PluginSDK } from "./types";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();

  // Types
  interface ScheduledItem {
    id: string;
    series_id: string | null;
    description: string;
    amount: number;
    date: string;
  }

  interface Account {
    id: string;
    name: string;
    balance: number;
  }

  interface Suggestion {
    description: string;
    amount: number;
    frequency: string;
    interval_days: number;
    last_date: string;
    occurrence_count: number;
  }

  interface ProjectedItem extends ScheduledItem {
    running_balance: number;
  }

  // State
  let items = $state<ScheduledItem[]>([]);
  let accounts = $state<Account[]>([]);
  let selectedAccountIds = $state<Set<string>>(new Set());
  let suggestions = $state<Suggestion[]>([]);
  let isLoading = $state(true);
  let horizonMonths = $state(3);
  let cursorIndex = $state(0);

  // Modal state
  let showAddModal = $state(false);
  let showEditModal = $state(false);
  let editingItem = $state<ScheduledItem | null>(null);

  // Form state
  let formDescription = $state("");
  let formAmount = $state("");
  let formIsIncome = $state(false);
  let formScheduleType = $state<"once" | "recurring">("once");
  let formDate = $state("");
  let formFrequency = $state("monthly");
  let formStartDate = $state("");
  let formDurationMonths = $state(3);
  let formDayOfMonth = $state(1); // 1-28 or 0 for "last day"

  // Refs
  let containerEl = $state<HTMLDivElement | null>(null);

  // Computed
  let startingBalance = $derived(
    accounts
      .filter(a => selectedAccountIds.has(a.id))
      .reduce((sum, a) => sum + a.balance, 0)
  );

  let projectedItems = $derived.by(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const horizonDate = new Date(today);
    horizonDate.setMonth(horizonDate.getMonth() + horizonMonths);

    // Filter items within horizon and sort by date
    const filtered = items
      .filter(item => {
        const itemDate = new Date(item.date);
        return itemDate >= today && itemDate <= horizonDate;
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Calculate running balance
    let balance = startingBalance;
    return filtered.map(item => {
      balance = Math.round((balance + item.amount) * 100) / 100;
      return { ...item, running_balance: balance };
    });
  });

  let lowestBalance = $derived(
    projectedItems.length > 0
      ? Math.min(startingBalance, ...projectedItems.map(p => p.running_balance))
      : startingBalance
  );

  let endingBalance = $derived(
    projectedItems.length > 0
      ? projectedItems[projectedItems.length - 1].running_balance
      : startingBalance
  );

  let totalIncome = $derived(
    projectedItems.filter(p => p.amount > 0).reduce((sum, p) => sum + p.amount, 0)
  );

  let totalExpenses = $derived(
    projectedItems.filter(p => p.amount < 0).reduce((sum, p) => sum + Math.abs(p.amount), 0)
  );

  let selectedItem = $derived(
    cursorIndex < projectedItems.length ? projectedItems[cursorIndex] : null
  );


  // Lifecycle
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    unsubscribe = sdk.onDataRefresh(() => {
      loadData();
    });

    await ensureTable();
    await loadAccounts();
    await loadItems();
    await loadSuggestions();
    isLoading = false;

    containerEl?.focus();
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Database
  async function ensureTable() {
    try {
      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_treeline_cashflow_items (
          id VARCHAR PRIMARY KEY,
          series_id VARCHAR,
          description VARCHAR NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          date DATE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await sdk.execute(`
        CREATE INDEX IF NOT EXISTS idx_cashflow_items_date
        ON sys_plugin_treeline_cashflow_items(date)
      `);
      await sdk.execute(`
        CREATE INDEX IF NOT EXISTS idx_cashflow_items_series
        ON sys_plugin_treeline_cashflow_items(series_id)
      `);
    } catch (e) {
      // Tables may already exist
    }
  }

  async function loadAccounts() {
    try {
      const rows = await sdk.query<any>(
        "SELECT account_id, account_name, balance FROM sys_accounts ORDER BY account_name"
      );
      accounts = rows.map((r: any) => ({
        id: r[0] as string,
        name: r[1] as string,
        balance: r[2] as number,
      }));

      // Load saved selection or default to all
      const savedSelection = await sdk.settings.get("selectedAccountIds");
      if (savedSelection && Array.isArray(savedSelection)) {
        selectedAccountIds = new Set(savedSelection);
      } else if (accounts.length > 0) {
        // Default to first account (usually checking)
        selectedAccountIds = new Set([accounts[0].id]);
      }
    } catch (e) {
      console.error("Failed to load accounts", e);
    }
  }

  async function loadItems() {
    try {
      const rows = await sdk.query<any>(
        "SELECT id, series_id, description, amount, date FROM sys_plugin_treeline_cashflow_items ORDER BY date"
      );
      items = rows.map((r: any) => ({
        id: r[0] as string,
        series_id: r[1] as string | null,
        description: r[2] as string,
        amount: r[3] as number,
        date: r[4] as string,
      }));
    } catch (e) {
      console.error("Failed to load items", e);
    }
  }

  // Auto-detection SQL for suggestions
  const SUGGESTION_SQL = `WITH base_transactions AS (
  SELECT
    ROUND(amount, 2) as norm_amount,
    UPPER(description) as upper_desc,
    description,
    amount,
    transaction_date
  FROM transactions
  WHERE description IS NOT NULL AND description != ''
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
    AVG(mi.amount) as avg_amount,
    COUNT(*) + 1 as occurrence_count,
    AVG(mi.interval_days) as avg_interval,
    STDDEV(mi.interval_days) as stddev_interval,
    MAX(mi.transaction_date) as last_date
  FROM merchant_intervals mi
  GROUP BY mi.merchant_group, mi.norm_amount
  HAVING
    COUNT(*) >= 1
    AND AVG(mi.interval_days) BETWEEN 5 AND 400
)
SELECT description, avg_amount, occurrence_count, avg_interval, last_date
FROM merchant_stats
ORDER BY occurrence_count DESC, ABS(avg_amount) DESC`;

  async function loadSuggestions() {
    try {
      const rows = await sdk.query<any>(SUGGESTION_SQL);
      suggestions = rows.map((r: any) => {
        const interval = Math.round(r[3] as number);
        let frequency = "monthly";
        if (interval <= 8) frequency = "weekly";
        else if (interval <= 16) frequency = "biweekly";
        else if (interval <= 35) frequency = "monthly";
        else if (interval <= 100) frequency = "quarterly";
        else frequency = "annual";

        return {
          description: r[0] as string,
          amount: Math.round((r[1] as number) * 100) / 100,
          occurrence_count: r[2] as number,
          interval_days: interval,
          frequency,
          last_date: r[4] as string,
        };
      });
    } catch (e) {
      console.error("Failed to load suggestions", e);
    }
  }

  // Actions
  async function toggleAccount(accountId: string) {
    const newSelection = new Set(selectedAccountIds);
    if (newSelection.has(accountId)) {
      newSelection.delete(accountId);
    } else {
      newSelection.add(accountId);
    }
    selectedAccountIds = newSelection;
    await sdk.settings.set("selectedAccountIds", Array.from(newSelection));
  }

  function openAddModal(suggestion?: Suggestion) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const currentMonth = todayStr.substring(0, 7); // YYYY-MM

    if (suggestion) {
      formDescription = suggestion.description;
      formAmount = Math.abs(suggestion.amount).toString();
      formIsIncome = suggestion.amount > 0;
      formScheduleType = "recurring";
      formFrequency = suggestion.frequency;

      // Get day of month from last transaction, clamping to 1-28 or 0 for last day
      const lastDate = new Date(suggestion.last_date);
      const dayOfLastTx = lastDate.getDate();
      formDayOfMonth = dayOfLastTx > 28 ? 0 : dayOfLastTx; // 29+ becomes "last day"

      // For weekly/biweekly, calculate next occurrence
      if (suggestion.frequency === "weekly" || suggestion.frequency === "biweekly") {
        let nextDate = new Date(lastDate);
        nextDate.setDate(nextDate.getDate() + suggestion.interval_days);
        while (nextDate < today) {
          nextDate.setDate(nextDate.getDate() + suggestion.interval_days);
        }
        formStartDate = nextDate.toISOString().split('T')[0];
      } else {
        // For monthly+, use current or next month
        formStartDate = currentMonth;
      }
      formDurationMonths = 3;
    } else {
      formDescription = "";
      formAmount = "";
      formIsIncome = false;
      formScheduleType = "once";
      formDate = todayStr;
      formFrequency = "monthly";
      formStartDate = currentMonth;
      formDayOfMonth = today.getDate() > 28 ? 28 : today.getDate();
      formDurationMonths = 3;
    }
    showAddModal = true;
  }

  function closeAddModal() {
    showAddModal = false;
  }

  function generateId(): string {
    return crypto.randomUUID();
  }

  async function saveNewItem() {
    if (!formDescription.trim() || !formAmount) {
      sdk.toast.error("Please fill in description and amount");
      return;
    }

    const amount = parseFloat(formAmount) * (formIsIncome ? 1 : -1);

    try {
      if (formScheduleType === "once") {
        // Single item
        const id = generateId();
        const escaped = formDescription.replace(/'/g, "''");
        await sdk.execute(`
          INSERT INTO sys_plugin_treeline_cashflow_items (id, series_id, description, amount, date)
          VALUES ('${id}', NULL, '${escaped}', ${amount}, '${formDate}')
        `);
      } else {
        // Recurring - generate multiple items with same series_id
        const seriesId = generateId();
        const escaped = formDescription.replace(/'/g, "''");

        if (formFrequency === "weekly" || formFrequency === "biweekly") {
          // Day-based intervals
          const startDate = new Date(formStartDate);
          const endDate = new Date(startDate);
          endDate.setMonth(endDate.getMonth() + formDurationMonths);
          const intervalDays = getIntervalDays(formFrequency);

          let currentDate = new Date(startDate);
          while (currentDate <= endDate) {
            const id = generateId();
            const dateStr = currentDate.toISOString().split('T')[0];
            await sdk.execute(`
              INSERT INTO sys_plugin_treeline_cashflow_items (id, series_id, description, amount, date)
              VALUES ('${id}', '${seriesId}', '${escaped}', ${amount}, '${dateStr}')
            `);
            currentDate.setDate(currentDate.getDate() + intervalDays);
          }
        } else {
          // Month-based: monthly, quarterly, annual
          // formStartDate is YYYY-MM format
          const [startYear, startMonth] = formStartDate.split('-').map(Number);
          const monthIncrement = formFrequency === "monthly" ? 1 : formFrequency === "quarterly" ? 3 : 12;

          let currentYear = startYear;
          let currentMonth = startMonth - 1; // JS months are 0-indexed
          let count = 0;
          const maxOccurrences = Math.ceil(formDurationMonths / monthIncrement);

          while (count < maxOccurrences) {
            const currentDate = getDateForMonth(currentYear, currentMonth, formDayOfMonth);
            const id = generateId();
            const dateStr = currentDate.toISOString().split('T')[0];
            await sdk.execute(`
              INSERT INTO sys_plugin_treeline_cashflow_items (id, series_id, description, amount, date)
              VALUES ('${id}', '${seriesId}', '${escaped}', ${amount}, '${dateStr}')
            `);

            currentMonth += monthIncrement;
            if (currentMonth >= 12) {
              currentYear += Math.floor(currentMonth / 12);
              currentMonth = currentMonth % 12;
            }
            count++;
          }
        }
      }

      await loadItems();
      closeAddModal();
      sdk.toast.success("Added", formDescription);
    } catch (e) {
      sdk.toast.error("Failed to add", e instanceof Error ? e.message : String(e));
    }
  }

  function getIntervalDays(frequency: string): number {
    switch (frequency) {
      case "weekly": return 7;
      case "biweekly": return 14;
      default: return 7;
    }
  }

  function getOrdinalSuffix(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  function getDateForMonth(year: number, month: number, dayOfMonth: number): Date {
    // dayOfMonth: 1-28 for specific day, 0 for last day
    if (dayOfMonth === 0) {
      // Last day of month: go to first of next month, subtract one day
      return new Date(year, month + 1, 0);
    }
    return new Date(year, month, dayOfMonth);
  }

  function advanceByMonths(date: Date, months: number, dayOfMonth: number): Date {
    const newMonth = date.getMonth() + months;
    const newYear = date.getFullYear() + Math.floor(newMonth / 12);
    const adjustedMonth = ((newMonth % 12) + 12) % 12;
    return getDateForMonth(newYear, adjustedMonth, dayOfMonth);
  }

  function openEditModal(item: ScheduledItem) {
    editingItem = item;
    formDescription = item.description;
    formAmount = Math.abs(item.amount).toString();
    formIsIncome = item.amount > 0;
    formDate = item.date;
    showEditModal = true;
  }

  function closeEditModal() {
    showEditModal = false;
    editingItem = null;
  }

  async function saveEditedItem() {
    if (!editingItem) return;

    const amount = parseFloat(formAmount) * (formIsIncome ? 1 : -1);
    const escaped = formDescription.replace(/'/g, "''");

    try {
      await sdk.execute(`
        UPDATE sys_plugin_treeline_cashflow_items
        SET description = '${escaped}', amount = ${amount}, date = '${formDate}'
        WHERE id = '${editingItem.id}'
      `);
      await loadItems();
      closeEditModal();
      sdk.toast.success("Updated", formDescription);
    } catch (e) {
      sdk.toast.error("Failed to update", e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteItem(item: ScheduledItem, deleteAll: boolean = false) {
    try {
      if (deleteAll && item.series_id) {
        await sdk.execute(`
          DELETE FROM sys_plugin_treeline_cashflow_items
          WHERE series_id = '${item.series_id}'
        `);
        sdk.toast.success("Deleted series", item.description);
      } else {
        await sdk.execute(`
          DELETE FROM sys_plugin_treeline_cashflow_items
          WHERE id = '${item.id}'
        `);
        sdk.toast.success("Deleted", item.description);
      }
      await loadItems();
    } catch (e) {
      sdk.toast.error("Failed to delete", e instanceof Error ? e.message : String(e));
    }
  }

  async function resetPluginData() {
    if (!confirm("This will delete all scheduled items. Are you sure?")) return;

    try {
      await sdk.execute("DROP TABLE IF EXISTS sys_plugin_treeline_cashflow_items");
      await ensureTable();
      items = [];
      sdk.toast.success("Plugin data reset");
    } catch (e) {
      sdk.toast.error("Failed to reset", e instanceof Error ? e.message : String(e));
    }
  }

  async function setHorizon(months: number) {
    horizonMonths = months;
    await sdk.settings.set("horizonMonths", months);
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

  function formatCurrencyFull(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  function formatDateLong(dateStr: string): string {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  // Keyboard navigation
  function handleKeyDown(e: KeyboardEvent) {
    if (showAddModal || showEditModal) return;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        cursorIndex = Math.min(cursorIndex + 1, projectedItems.length - 1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        cursorIndex = Math.max(cursorIndex - 1, 0);
        break;
      case "a":
        e.preventDefault();
        openAddModal();
        break;
      case "Enter":
      case "e":
        if (selectedItem) {
          e.preventDefault();
          openEditModal(selectedItem);
        }
        break;
      case "d":
      case "Backspace":
        if (selectedItem) {
          e.preventDefault();
          deleteItem(selectedItem, e.shiftKey);
        }
        break;
    }
  }

  // Keep cursor in bounds
  $effect(() => {
    if (cursorIndex >= projectedItems.length) {
      cursorIndex = Math.max(0, projectedItems.length - 1);
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
      <div class="header-spacer"></div>
      <button class="reset-btn" onclick={resetPluginData}>Reset Data</button>
      <button class="add-btn" onclick={() => openAddModal()}>+ Add</button>
    </div>

    <!-- Account Selector -->
    <div class="account-selector">
      <span class="account-label">Accounts:</span>
      {#each accounts as account}
        <button
          class="account-chip"
          class:selected={selectedAccountIds.has(account.id)}
          onclick={() => toggleAccount(account.id)}
        >
          {account.name}
        </button>
      {/each}
      <span class="balance-display">
        Balance: <strong>{formatCurrency(startingBalance)}</strong>
      </span>
    </div>
  </header>

  <!-- Summary Cards -->
  {#if !isLoading}
    <div class="summary-cards">
      <div class="summary-card">
        <span class="card-label">Current</span>
        <span class="card-value">{formatCurrency(startingBalance)}</span>
      </div>
      <div class="summary-card">
        <span class="card-label">Lowest</span>
        <span class="card-value" class:danger={lowestBalance < 0}>
          {formatCurrency(lowestBalance)}
        </span>
      </div>
      <div class="summary-card">
        <span class="card-label">After {horizonMonths}mo</span>
        <span class="card-value">{formatCurrency(endingBalance)}</span>
      </div>
      <div class="summary-card">
        <span class="card-label">Income</span>
        <span class="card-value positive">+{formatCurrency(totalIncome)}</span>
      </div>
      <div class="summary-card">
        <span class="card-label">Expenses</span>
        <span class="card-value negative">-{formatCurrency(totalExpenses)}</span>
      </div>
      <div class="horizon-selector">
        <button class:active={horizonMonths === 3} onclick={() => setHorizon(3)}>3mo</button>
        <button class:active={horizonMonths === 6} onclick={() => setHorizon(6)}>6mo</button>
        <button class:active={horizonMonths === 12} onclick={() => setHorizon(12)}>1yr</button>
      </div>
    </div>
  {/if}

  <!-- Main Content -->
  <div class="main-content">
    {#if isLoading}
      <div class="loading">
        <div class="spinner"></div>
        <span>Loading...</span>
      </div>
    {:else if projectedItems.length === 0}
      <div class="empty">
        <p class="empty-title">No scheduled items</p>
        <p class="empty-hint">Add your expected income and expenses to see your cash flow projection.</p>
        <button class="empty-add-btn" onclick={() => openAddModal()}>+ Add First Item</button>
      </div>
    {:else}
      <div class="projection-table">
        <div class="table-header">
          <span class="col-date">Date</span>
          <span class="col-desc">Description</span>
          <span class="col-amount">Amount</span>
          <span class="col-balance">Balance</span>
        </div>
        <div class="table-body">
          {#each projectedItems as item, i}
            <div
              class="table-row"
              class:selected={i === cursorIndex}
              class:income={item.amount > 0}
              class:series={item.series_id !== null}
              onclick={() => cursorIndex = i}
              ondblclick={() => openEditModal(item)}
              role="button"
              tabindex="0"
            >
              <span class="col-date">{formatDateLong(item.date)}</span>
              <span class="col-desc">
                {item.description}
                {#if item.series_id}
                  <span class="series-badge">recurring</span>
                {/if}
              </span>
              <span class="col-amount" class:positive={item.amount > 0}>
                {item.amount > 0 ? '+' : ''}{formatCurrencyFull(item.amount)}
              </span>
              <span class="col-balance" class:danger={item.running_balance < 0}>
                {formatCurrency(item.running_balance)}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Keyboard Hints -->
  <footer class="keyboard-hints">
    <span class="hint"><kbd>j</kbd><kbd>k</kbd> navigate</span>
    <span class="hint"><kbd>a</kbd> add</span>
    <span class="hint"><kbd>e</kbd> edit</span>
    <span class="hint"><kbd>d</kbd> delete</span>
    <span class="hint"><kbd>⇧d</kbd> delete series</span>
  </footer>
</div>

<!-- Add Modal -->
{#if showAddModal}
  <div class="modal-backdrop" onclick={closeAddModal} role="dialog">
    <div class="modal" onclick={(e) => e.stopPropagation()} role="document">
      <div class="modal-header">
        <h2>Add Scheduled Item</h2>
        <button class="modal-close" onclick={closeAddModal}>×</button>
      </div>

      <!-- Suggestions -->
      {#if suggestions.length > 0}
        <div class="suggestions-section">
          <h3 class="suggestions-title">Start from detected pattern:</h3>
          <div class="suggestions-list">
            {#each suggestions.slice(0, 8) as suggestion}
              <button class="suggestion-item" onclick={() => openAddModal(suggestion)}>
                <span class="suggestion-desc">{suggestion.description}</span>
                <span class="suggestion-amount" class:positive={suggestion.amount > 0}>
                  {suggestion.amount > 0 ? '+' : ''}{formatCurrencyFull(suggestion.amount)}
                </span>
                <span class="suggestion-freq">~{suggestion.frequency}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="modal-form">
        <div class="form-group">
          <label>Description</label>
          <input type="text" bind:value={formDescription} placeholder="e.g., Rent, Paycheck" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Amount</label>
            <input type="number" bind:value={formAmount} placeholder="0.00" step="0.01" />
          </div>
          <div class="form-group type-toggle">
            <label>Type</label>
            <div class="toggle-buttons">
              <button class:active={!formIsIncome} onclick={() => formIsIncome = false}>Expense</button>
              <button class:active={formIsIncome} onclick={() => formIsIncome = true}>Income</button>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Schedule</label>
          <div class="toggle-buttons">
            <button class:active={formScheduleType === "once"} onclick={() => formScheduleType = "once"}>
              One-time
            </button>
            <button class:active={formScheduleType === "recurring"} onclick={() => formScheduleType = "recurring"}>
              Recurring
            </button>
          </div>
        </div>

        {#if formScheduleType === "once"}
          <div class="form-group">
            <label>Date</label>
            <input type="date" bind:value={formDate} />
          </div>
        {:else}
          <div class="form-group">
            <label>Frequency</label>
            <select bind:value={formFrequency}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annually</option>
            </select>
          </div>

          {#if formFrequency === "weekly" || formFrequency === "biweekly"}
            <div class="form-group">
              <label>Starting</label>
              <input type="date" bind:value={formStartDate} />
            </div>
          {:else}
            <div class="form-row">
              <div class="form-group">
                <label>Day of month</label>
                <select bind:value={formDayOfMonth}>
                  {#each Array.from({length: 28}, (_, i) => i + 1) as day}
                    <option value={day}>{day}{getOrdinalSuffix(day)}</option>
                  {/each}
                  <option value={0}>Last day</option>
                </select>
              </div>
              <div class="form-group">
                <label>Starting month</label>
                <input type="month" bind:value={formStartDate} />
              </div>
            </div>
          {/if}

          <div class="form-group">
            <label>Generate for</label>
            <select bind:value={formDurationMonths}>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>1 year</option>
            </select>
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn secondary" onclick={closeAddModal}>Cancel</button>
        <button class="btn primary" onclick={saveNewItem}>Add</button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Modal -->
{#if showEditModal && editingItem}
  <div class="modal-backdrop" onclick={closeEditModal} role="dialog">
    <div class="modal" onclick={(e) => e.stopPropagation()} role="document">
      <div class="modal-header">
        <h2>Edit Item</h2>
        <button class="modal-close" onclick={closeEditModal}>×</button>
      </div>

      <div class="modal-form">
        <div class="form-group">
          <label>Description</label>
          <input type="text" bind:value={formDescription} />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Amount</label>
            <input type="number" bind:value={formAmount} step="0.01" />
          </div>
          <div class="form-group type-toggle">
            <label>Type</label>
            <div class="toggle-buttons">
              <button class:active={!formIsIncome} onclick={() => formIsIncome = false}>Expense</button>
              <button class:active={formIsIncome} onclick={() => formIsIncome = true}>Income</button>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Date</label>
          <input type="date" bind:value={formDate} />
        </div>

        {#if editingItem.series_id}
          <p class="series-note">
            This item is part of a recurring series.
            Editing only affects this instance.
          </p>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn danger" onclick={() => { deleteItem(editingItem!); closeEditModal(); }}>
          Delete
        </button>
        {#if editingItem.series_id}
          <button class="btn danger-outline" onclick={() => { deleteItem(editingItem!, true); closeEditModal(); }}>
            Delete Series
          </button>
        {/if}
        <div class="footer-spacer"></div>
        <button class="btn secondary" onclick={closeEditModal}>Cancel</button>
        <button class="btn primary" onclick={saveEditedItem}>Save</button>
      </div>
    </div>
  </div>
{/if}

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
    margin: 0;
  }

  .header-spacer, .footer-spacer {
    flex: 1;
  }

  .add-btn {
    padding: 6px 14px;
    background: var(--accent-primary);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .add-btn:hover {
    opacity: 0.9;
  }

  .reset-btn {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .reset-btn:hover {
    color: var(--accent-danger);
    border-color: var(--accent-danger);
  }

  /* Account Selector */
  .account-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    margin-top: var(--spacing-sm, 8px);
    flex-wrap: wrap;
  }

  .account-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .account-chip {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .account-chip:hover {
    border-color: var(--text-muted);
  }

  .account-chip.selected {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: white;
  }

  .balance-display {
    margin-left: auto;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .balance-display strong {
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }

  /* Summary Cards */
  .summary-cards {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 12px);
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
    overflow-x: auto;
  }

  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    min-width: 90px;
  }

  .card-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .card-value {
    font-size: 16px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    color: var(--text-primary);
  }

  .card-value.positive { color: var(--accent-success, #3fb950); }
  .card-value.negative { color: var(--accent-danger, #f85149); }
  .card-value.danger { color: var(--accent-danger, #f85149); }

  .horizon-selector {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }

  .horizon-selector button {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 11px;
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

  .empty-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0;
  }

  .empty-hint {
    font-size: 13px;
    margin: 0;
    text-align: center;
    max-width: 300px;
  }

  .empty-add-btn {
    margin-top: var(--spacing-md, 12px);
    padding: 10px 20px;
    background: var(--accent-primary);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }

  /* Projection Table */
  .projection-table {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .table-header {
    display: grid;
    grid-template-columns: 100px 1fr 120px 100px;
    gap: var(--spacing-md, 12px);
    padding: var(--spacing-sm, 8px) var(--spacing-lg, 16px);
    background: var(--bg-secondary);
    border-bottom: 2px solid var(--border-primary);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .table-body {
    flex: 1;
    overflow-y: auto;
  }

  .table-row {
    display: grid;
    grid-template-columns: 100px 1fr 120px 100px;
    gap: var(--spacing-md, 12px);
    padding: var(--spacing-sm, 8px) var(--spacing-lg, 16px);
    border-bottom: 1px solid var(--border-primary);
    font-size: 13px;
    cursor: pointer;
  }

  .table-row:hover {
    background: var(--bg-secondary);
  }

  .table-row.selected {
    background: var(--bg-active, rgba(88, 166, 255, 0.1));
  }

  .table-row.income {
    border-left: 3px solid var(--accent-success, #3fb950);
  }

  .table-row:not(.income) {
    border-left: 3px solid var(--accent-danger, #f85149);
  }

  .col-date {
    color: var(--text-muted);
    font-size: 12px;
  }

  .col-desc {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    color: var(--text-primary);
    font-weight: 500;
  }

  .series-badge {
    font-size: 9px;
    padding: 2px 6px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border-radius: 3px;
    text-transform: uppercase;
  }

  .col-amount {
    text-align: right;
    font-family: var(--font-mono, monospace);
    color: var(--accent-danger, #f85149);
  }

  .col-amount.positive {
    color: var(--accent-success, #3fb950);
  }

  .col-balance {
    text-align: right;
    font-family: var(--font-mono, monospace);
    font-weight: 600;
  }

  .col-balance.danger {
    color: var(--accent-danger, #f85149);
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

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    width: 500px;
    max-width: 95vw;
    max-height: 85vh;
    overflow-y: auto;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    border-bottom: 1px solid var(--border-primary);
  }

  .modal-header h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  .modal-close {
    background: none;
    border: none;
    font-size: 24px;
    color: var(--text-muted);
    cursor: pointer;
    line-height: 1;
  }

  .modal-close:hover {
    color: var(--text-primary);
  }

  /* Suggestions */
  .suggestions-section {
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    border-bottom: 1px solid var(--border-primary);
  }

  .suggestions-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin: 0 0 var(--spacing-sm, 8px) 0;
  }

  .suggestions-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }

  .suggestion-item {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: var(--spacing-md, 12px);
    padding: var(--spacing-sm, 8px);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .suggestion-item:hover {
    border-color: var(--accent-primary);
  }

  .suggestion-desc {
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .suggestion-amount {
    font-family: var(--font-mono, monospace);
    color: var(--accent-danger, #f85149);
  }

  .suggestion-amount.positive {
    color: var(--accent-success, #3fb950);
  }

  .suggestion-freq {
    color: var(--text-muted);
  }

  /* Form */
  .modal-form {
    padding: var(--spacing-lg, 16px);
  }

  .form-group {
    margin-bottom: var(--spacing-md, 12px);
  }

  .form-group label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .form-group input {
    width: 100%;
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
  }

  .form-group select {
    width: 100%;
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .form-group select option {
    background: var(--bg-secondary);
    color: var(--text-primary);
    padding: 8px;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-md, 12px);
  }

  .toggle-buttons {
    display: flex;
    gap: 4px;
  }

  .toggle-buttons button {
    flex: 1;
    padding: 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .toggle-buttons button:hover {
    background: var(--bg-secondary);
  }

  .toggle-buttons button.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: white;
  }

  .series-note {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: var(--spacing-sm, 8px);
    border-radius: 4px;
    margin: 0;
  }

  /* Modal Footer */
  .modal-footer {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    border-top: 1px solid var(--border-primary);
  }

  .btn {
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
  }

  .btn.primary {
    background: var(--accent-primary);
    color: white;
  }

  .btn.primary:hover {
    opacity: 0.9;
  }

  .btn.secondary {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
  }

  .btn.secondary:hover {
    background: var(--bg-primary);
  }

  .btn.danger {
    background: var(--accent-danger, #f85149);
    color: white;
  }

  .btn.danger-outline {
    background: transparent;
    border: 1px solid var(--accent-danger, #f85149);
    color: var(--accent-danger, #f85149);
  }

  .btn.danger-outline:hover {
    background: rgba(248, 81, 73, 0.1);
  }
</style>
