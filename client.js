// State management
let activeAccount = null;
let registry = {};
let selectedRightClickNickname = null;
let isManualSwapInProgress = false;
let activeGoals = [];
let showDisabledGoals = false;

// DOM Elements
const btnSync = document.getElementById('btn-sync');
const btnAddAccount = document.getElementById('btn-add-account');
const activeAccountContainer = document.getElementById('active-account-container');
const accountsList = document.getElementById('accounts-list');
const otherAccountsSection = document.getElementById('other-accounts-section');
const customContextMenu = document.getElementById('custom-context-menu');
const contextMenuDelete = document.getElementById('context-menu-delete');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

// Fetch dashboard state on load
async function updateDashboard(isBackground = false) {
  if (!isBackground) setLoadingState(true);
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Failed to fetch status');
    const data = await res.json();
    
    const prevActiveUserId = activeAccount?.user_id;
    const prevActiveAccountId = activeAccount?.account_id;
    
    activeAccount = data.active;
    registry = data.registry || {};
    activeGoals = data.goals || [];
    
    // Check if active account auto-swapped
    if (prevActiveUserId && activeAccount && 
        (prevActiveUserId !== activeAccount.user_id || prevActiveAccountId !== activeAccount.account_id)) {
      let newNickname = 'Active Session';
      for (const nick of Object.keys(registry)) {
        const acc = registry[nick];
        if (acc.user_id === activeAccount.user_id && acc.account_id === activeAccount.account_id) {
          newNickname = nick;
          break;
        }
      }
      if (isManualSwapInProgress) {
        isManualSwapInProgress = false; // Reset the manual swap flag and bypass warning
      } else {
        showToast(`Account limit reached! Auto-swapped active session to "${newNickname}"`, 'warning');
      }
    }
    
    renderDashboard();
  } catch (err) {
    console.error(err);
    if (!isBackground) showToast('Error connecting to server daemon', 'error');
  } finally {
    if (!isBackground) setLoadingState(false);
  }
}

function setLoadingState(isLoading) {
  if (isLoading) {
    btnSync.classList.add('spinning');
  } else {
    btnSync.classList.remove('spinning');
  }
}

// Format reset unix timestamp to relative string
function formatResetTime(resetUnixSecs) {
  if (!resetUnixSecs) return 'N/A';
  const resetMs = resetUnixSecs * 1000;
  const diff = resetMs - Date.now();
  if (diff <= 0) {
    return 'now';
  }
  
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const minsLeft = minutes % 60;
    return `in ${hours}h ${minsLeft}m`;
  }
  
  const days = Math.floor(hours / 24);
  const hoursLeft = hours % 24;
  const minsLeft = minutes % 60;
  return `in ${days}d ${hoursLeft}h ${minsLeft}m`;
}

// Generate the HTML for an SVG curved speedometer gauge
function createSpeedometerGauge(usedPercent, resetAt, label) {
  const percent = Math.min(100, Math.max(0, Math.round(usedPercent || 0)));
  
  // Speedometer arc calculations (r = 30)
  const circumference = 188.49;
  const arcLength = 141.37; // 270 degrees (75% of circumference)
  const filledLength = (percent / 100) * arcLength;
  
  // Set stroke classes for warnings
  let strokeClass = '';
  if (percent >= 98) {
    strokeClass = 'danger';
  } else if (percent >= 90) {
    strokeClass = 'warning';
  }
  
  const resetsAtStr = resetAt ? formatResetTime(resetAt) : 'N/A';
  
  return `
    <div class="speedometer-container tooltip-container">
      <svg class="speedometer-svg" viewBox="0 0 100 100">
        <circle class="speedo-track" cx="50" cy="50" r="30"></circle>
        <circle class="speedo-fill ${strokeClass}" cx="50" cy="50" r="30" style="stroke-dasharray: ${filledLength} ${circumference};"></circle>
      </svg>
      <div class="speedo-label-center speedo-label-default">${label}</div>
      <div class="speedo-label-center speedo-label-hover" style="font-size: 0.85rem;">${percent}%</div>
      <div class="tooltip-text">Resets ${resetsAtStr}</div>
    </div>
  `;
}

// Render the active card and the other accounts list
function renderDashboard() {
  renderActiveAccount();
  renderRegistryList();
}

// Render currently active card
function renderActiveAccount() {
  if (!activeAccount) {
    activeAccountContainer.innerHTML = `
      <div class="card active-card loading-card">
        <div class="loading-text">No active session found in ~/.codex/auth.json</div>
      </div>
    `;
    return;
  }
  
  // Find matching nickname in registry
  const keys = Object.keys(registry);
  let nickname = 'Active Session';
  let usage = null;
  
  for (const nick of keys) {
    const acc = registry[nick];
    if (acc.user_id === activeAccount.user_id && acc.account_id === activeAccount.account_id) {
      nickname = nick;
      usage = acc.usage;
      break;
    }
  }
  
  const primaryUsed = usage?.rate_limit?.primary_window?.used_percent || 0;
  const primaryReset = usage?.rate_limit?.primary_window?.reset_at || null;
  const secondaryUsed = usage?.rate_limit?.secondary_window?.used_percent || 0;
  const secondaryReset = usage?.rate_limit?.secondary_window?.reset_at || null;
  
  let goalsHtml = '';
  if (activeGoals && activeGoals.length > 0) {
    const normalGoals = activeGoals.filter(g => !g.disabled);
    const disabledGoals = activeGoals.filter(g => g.disabled);
    
    let normalGoalsHtml = '';
    if (normalGoals.length > 0) {
      const pills = normalGoals.map(g => {
        let statusLabel = g.status;
        let statusClass = 'pill-status-paused';
        if (g.status === 'active') {
          statusLabel = 'Active';
          statusClass = 'pill-status-active';
        } else if (g.status === 'usage_limited') {
          statusLabel = 'Quota Paused';
          statusClass = 'pill-status-limited';
        } else if (g.status === 'paused') {
          statusLabel = 'Paused';
          statusClass = 'pill-status-paused';
        } else if (g.status === 'blocked') {
          statusLabel = 'Blocked';
          statusClass = 'pill-status-blocked';
        } else if (g.status === 'budget_limited') {
          statusLabel = 'Budget Limited';
          statusClass = 'pill-status-budget';
        }
        
        const cleanTitle = (g.title || 'Untitled Thread').split('\n')[0].trim();
        
        return `
          <div class="goal-pill" data-thread-id="${g.thread_id}" title="Thread ID: ${g.thread_id}">
            <div class="goal-pill-dot-container tooltip-container">
              <span class="goal-pill-dot ${statusClass}"></span>
              <div class="tooltip-text">${statusLabel}</div>
            </div>
            <span class="goal-pill-title">${cleanTitle}</span>
            <span class="goal-pill-project">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="project-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span>${g.project}</span>
            </span>
          </div>
        `;
      }).join('');
      normalGoalsHtml = `<div class="active-goals-list">${pills}</div>`;
    }
    
    let disabledGoalsHtml = '';
    if (disabledGoals.length > 0) {
      const pills = disabledGoals.map(g => {
        const cleanTitle = (g.title || 'Untitled Thread').split('\n')[0].trim();
        return `
          <div class="goal-pill goal-pill-disabled" data-thread-id="${g.thread_id}" title="Thread ID: ${g.thread_id}">
            <div class="goal-pill-dot-container tooltip-container">
              <span class="goal-pill-dot pill-status-disabled"></span>
              <div class="tooltip-text">Disabled</div>
            </div>
            <span class="goal-pill-title">${cleanTitle}</span>
            <span class="goal-pill-project">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="project-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span>${g.project}</span>
            </span>
          </div>
        `;
      }).join('');
      
      disabledGoalsHtml = `
        <div class="disabled-goals-section">
          <div class="disabled-goals-toggle" id="disabled-goals-toggle">Disabled (${disabledGoals.length})</div>
          <div class="active-goals-list disabled-goals-list" id="disabled-goals-list" style="display: ${showDisabledGoals ? 'flex' : 'none'};">
            ${pills}
          </div>
        </div>
      `;
    }
    
    goalsHtml = normalGoalsHtml + disabledGoalsHtml;
  }
  
  activeAccountContainer.innerHTML = `
    <div class="card active-card" data-nickname="${nickname}">
      <div class="card-row">
        <div class="card-left">
          <div class="name-tooltip-container">
            <h3 class="account-name" title="Double click to edit nickname" data-nickname="${nickname}">${nickname}</h3>
            <div class="name-tooltip-text">${activeAccount.email}</div>
          </div>
        </div>
        <div class="card-right">
          <div class="usage-meters-row">
            ${createSpeedometerGauge(primaryUsed, primaryReset, '5H')}
            ${createSpeedometerGauge(secondaryUsed, secondaryReset, 'W')}
          </div>
        </div>
      </div>
    </div>
    ${goalsHtml}
  `;
  
  // Wire double-click inline renaming
  const elName = activeAccountContainer.querySelector('.account-name');
  if (elName && nickname !== 'Active Session') {
    elName.addEventListener('dblclick', () => makeEditable(elName, nickname));
  }

  // Wire disabled section toggle
  const elToggle = activeAccountContainer.querySelector('#disabled-goals-toggle');
  if (elToggle) {
    elToggle.addEventListener('click', () => {
      showDisabledGoals = !showDisabledGoals;
      const elList = activeAccountContainer.querySelector('#disabled-goals-list');
      if (elList) {
        elList.style.display = showDisabledGoals ? 'flex' : 'none';
      }
    });
  }

  // Wire goal pill clicks to toggle disable status
  const goalPills = activeAccountContainer.querySelectorAll('.goal-pill');
  goalPills.forEach(pill => {
    pill.addEventListener('click', async () => {
      const threadId = pill.getAttribute('data-thread-id');
      try {
        showToast('Updating goal status...', 'loading');
        const res = await fetch('/api/goals/toggle-disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: threadId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to toggle status');
        showToast('Goal status updated', 'success');
        updateDashboard();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  });
}

// Render inactive registry accounts
function renderRegistryList() {
  const keys = Object.keys(registry);
  
  // Filter out the active account from other accounts
  const inactiveKeys = keys.filter(nickname => {
    const account = registry[nickname];
    const isActive = activeAccount && 
                     (activeAccount.user_id === account.user_id) && 
                     (activeAccount.account_id === account.account_id);
    return !isActive;
  });
  
  if (inactiveKeys.length === 0) {
    otherAccountsSection.style.display = 'none';
    accountsList.innerHTML = '';
    return;
  }
  
  otherAccountsSection.style.display = 'block';
  accountsList.innerHTML = '';
  
  inactiveKeys.sort().forEach(nickname => {
    const account = registry[nickname];
    const usage = account.usage;
    
    const primaryUsed = usage?.rate_limit?.primary_window?.used_percent || 0;
    const primaryReset = usage?.rate_limit?.primary_window?.reset_at || null;
    const secondaryUsed = usage?.rate_limit?.secondary_window?.used_percent || 0;
    const secondaryReset = usage?.rate_limit?.secondary_window?.reset_at || null;
    
    const card = document.createElement('div');
    card.className = 'card registry-card';
    card.setAttribute('data-nickname', nickname);
    
    card.innerHTML = `
      <div class="card-row">
        <div class="card-left">
          <button class="btn btn-swap" title="Swap to this account" style="padding: 5px; margin-right: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 17H4M4 17l4-4M4 17l4 4M4 7h16M20 7l-4-4M20 7l-4 4"/></svg>
          </button>
          <div class="name-tooltip-container">
            <h3 class="account-name" title="Double click to edit nickname" data-nickname="${nickname}">${nickname}</h3>
            <div class="name-tooltip-text">${account.email}</div>
          </div>
        </div>
        <div class="card-right">
          <div class="usage-meters-row">
            ${createSpeedometerGauge(primaryUsed, primaryReset, '5H')}
            ${createSpeedometerGauge(secondaryUsed, secondaryReset, 'W')}
          </div>
        </div>
      </div>
    `;
    
    // Wire double-click renaming
    const elName = card.querySelector('.account-name');
    if (elName) {
      elName.addEventListener('dblclick', () => makeEditable(elName, nickname));
    }
    
    // Wire Swap button
    const btnSwap = card.querySelector('.btn-swap');
    if (btnSwap) {
      btnSwap.addEventListener('click', () => swapAccount(nickname));
    }
    
    // Wire Right-click (Context Menu) for deletion
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, nickname);
    });
    
    accountsList.appendChild(card);
  });
}

// Convert Nickname label into inline text input
function makeEditable(el, oldNickname) {
  const currentText = el.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-nickname-input';
  input.value = currentText;
  
  const parent = el.parentNode;
  parent.replaceChild(input, el);
  input.focus();
  input.select();
  
  let isSaved = false;
  
  async function save() {
    if (isSaved) return;
    isSaved = true;
    const newNickname = input.value.trim();
    
    if (!newNickname || newNickname === oldNickname) {
      // Revert if empty or unchanged
      parent.replaceChild(el, input);
      return;
    }
    
    try {
      showToast('Renaming profile...', 'loading');
      const res = await fetch('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldNickname, newNickname })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rename');
      
      showToast('Profile renamed successfully', 'success');
      updateDashboard();
    } catch (err) {
      console.error(err);
      showToast(`Error: ${err.message}`, 'error');
      parent.replaceChild(el, input);
    }
  }
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      save();
    } else if (e.key === 'Escape') {
      isSaved = true;
      parent.replaceChild(el, input);
    }
  });
  
  input.addEventListener('blur', save);
}

// Action: Swap active Codex account
async function swapAccount(nickname) {
  try {
    showToast(`Swapping session to "${nickname}"...`, 'loading');
    isManualSwapInProgress = true;
    const res = await fetch('/api/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to swap');
    
    showToast(`Swapped to "${nickname}"`, 'success');
    await updateDashboard();
  } catch (err) {
    isManualSwapInProgress = false;
    console.error(err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Action: Sync active credentials and refresh all account limits
async function syncActiveSession() {
  btnSync.classList.add('spinning');
  try {
    showToast('Refreshing all accounts & limits...', 'loading');
    const res = await fetch('/api/refresh-all', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to refresh');
    
    showToast('All account limits refreshed', 'success');
    updateDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Refresh failed: ${err.message}`, 'error');
  } finally {
    btnSync.classList.remove('spinning');
  }
}

// Action: Delete registered profile
async function deleteAccount(nickname) {
  
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete');
    
    showToast(`Removed "${nickname}" from registry`, 'success');
    updateDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Action: Auto-update active account usage statistics every 30s
async function refreshActiveUsage() {
  if (!activeAccount) return;
  
  // Find current active nickname
  const keys = Object.keys(registry);
  let activeNickname = null;
  
  for (const nick of keys) {
    const acc = registry[nick];
    if (acc.user_id === activeAccount.user_id && acc.account_id === activeAccount.account_id) {
      activeNickname = nick;
      break;
    }
  }
  
  if (!activeNickname) return;
  
  try {
    await fetch('/api/update-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: activeNickname })
    });
    // Silent update in the background
    updateDashboard(true);
  } catch (e) {
    // Ignore background check errors silently
  }
}

// Right-click Custom Context Menu Logic
function showContextMenu(e, nickname) {
  selectedRightClickNickname = nickname;
  
  const menuWidth = 140;
  const menuHeight = 40;
  
  let x = e.clientX;
  let y = e.clientY;
  
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 8;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 8;
  }
  
  customContextMenu.style.left = `${x}px`;
  customContextMenu.style.top = `${y}px`;
  customContextMenu.style.display = 'block';
}

function hideContextMenu() {
  customContextMenu.style.display = 'none';
}

// Context Menu Action: Delete
contextMenuDelete.addEventListener('click', () => {
  if (selectedRightClickNickname) {
    deleteAccount(selectedRightClickNickname);
  }
  hideContextMenu();
});

// Hide context menu on outer clicks
window.addEventListener('click', hideContextMenu);
window.addEventListener('contextmenu', (e) => {
  // If not right-clicking on a registry card, hide context menu
  if (!e.target.closest('.registry-card')) {
    hideContextMenu();
  }
});

// Vector icons for professional popups (no emojis)
const TOAST_ICONS = {
  loading: `<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
  warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`
};

// Toast Notifications helper
let toastTimeout;
function showToast(message, type = 'info') {
  clearTimeout(toastTimeout);
  
  // Strip emojis and set message text
  const cleanMessage = message.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').replace(/[✅✨❌⚠️🔄🗑️🪐]/g, '').trim();
  toastMessage.textContent = cleanMessage;
  
  // Set custom vector icon
  const iconContainer = document.getElementById('toast-icon-container');
  if (iconContainer) {
    iconContainer.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  }
  
  toast.className = `toast show toast-${type}`;
  
  toastTimeout = setTimeout(() => {
    toast.className = 'toast';
  }, 4000);
}

// Action: Safely capture a NEW account's credentials without logging out.
// Runs an isolated `codex login` server-side; your active session is untouched.
let capturePoll = null;
async function captureAccount() {

  try {
    showToast('Opening Codex login in your browser…', 'loading');
    const res = await fetch('/api/capture/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.id) throw new Error(data.error || 'Failed to start login');
    pollCapture(data.id);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function pollCapture(id) {
  clearInterval(capturePoll);
  showToast('Waiting for you to finish signing in…', 'loading');
  capturePoll = setInterval(async () => {
    try {
      const res = await fetch('/api/capture/status?id=' + encodeURIComponent(id));
      const s = await res.json();
      if (s.status === 'completed') {
        clearInterval(capturePoll);
        showToast(`Added "${s.account.nickname}" (${s.account.email})`, 'success');
        updateDashboard();
      } else if (s.status === 'failed' || s.status === 'cancelled') {
        clearInterval(capturePoll);
        showToast(`Login ${s.status}${s.error ? ': ' + s.error : ''}`, 'error');
      }
    } catch (e) {
      /* keep polling */
    }
  }, 1500);
}

// Action: Clear active session to prepare for new login
async function clearActiveSession() {
  
  try {
    showToast('Clearing active session...', 'loading');
    const res = await fetch('/api/clear-active', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to clear session');
    
    showToast('Session cleared. Log in to your new account in Codex!', 'success');
    updateDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Event Listeners
btnSync.addEventListener('click', syncActiveSession);
btnAddAccount.addEventListener('click', captureAccount);

// Theme Toggle Logic
const themeToggle = document.getElementById('theme-toggle');
const currentTheme = localStorage.getItem('theme') || 'dark';

if (currentTheme === 'light') {
  document.body.classList.add('light-theme');
  updateThemeIcon('light');
} else {
  updateThemeIcon('dark');
}

themeToggle.addEventListener('click', () => {
  if (document.body.classList.contains('light-theme')) {
    document.body.classList.remove('light-theme');
    localStorage.setItem('theme', 'dark');
    updateThemeIcon('dark');
  } else {
    document.body.classList.add('light-theme');
    localStorage.setItem('theme', 'light');
    updateThemeIcon('light');
  }
});

function updateThemeIcon(theme) {
  const sunIcon = themeToggle.querySelector('.icon-sun');
  const moonIcon = themeToggle.querySelector('.icon-moon');
  if (theme === 'light') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }
}

// --- Settings panel ---
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettings = document.getElementById('btn-settings');
const settingsClose = document.getElementById('settings-close');
const setAutoswap = document.getElementById('set-autoswap');
const setThreshold = document.getElementById('set-threshold');
const setReloadmode = document.getElementById('set-reloadmode');
const setProxy = document.getElementById('set-proxy');
const proxyDetail = document.getElementById('proxy-detail');
const proxyStatusText = document.getElementById('proxy-status-text');
const proxySnippet = document.getElementById('proxy-snippet');
const btnCopySnippet = document.getElementById('btn-copy-snippet');

let proxyConfigSnippet = '';

async function loadSettings() {
  try {
    const [sRes, pRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/proxy/status'),
    ]);
    const s = await sRes.json();
    const p = await pRes.json();

    setAutoswap.checked = !!s.autoSwap;
    setThreshold.value = s.swapThreshold;
    setReloadmode.value = s.reloadMode;
    setProxy.checked = !!p.running;
    proxyConfigSnippet = p.configSnippet || '';
    proxySnippet.textContent = proxyConfigSnippet;
    renderProxyDetail(p);
  } catch (e) {
    showToast('Failed to load settings', 'error');
  }
}

function renderProxyDetail(p) {
  proxyDetail.style.display = setProxy.checked ? 'block' : 'none';
  proxyStatusText.textContent = p.running
    ? `Proxy running on 127.0.0.1:${p.port}`
    : 'Proxy stopped';
}

async function saveSettings(patch) {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    showToast('Failed to save setting', 'error');
  }
}

function openSettings() {
  loadSettings();
  settingsOverlay.classList.add('show');
}
function closeSettings() {
  settingsOverlay.classList.remove('show');
}

btnSettings.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOverlay.classList.contains('show')) closeSettings();
});

setAutoswap.addEventListener('change', () => saveSettings({ autoSwap: setAutoswap.checked }));
setReloadmode.addEventListener('change', () => saveSettings({ reloadMode: setReloadmode.value }));
setThreshold.addEventListener('change', () => {
  let v = parseInt(setThreshold.value, 10);
  if (isNaN(v)) v = 90;
  v = Math.min(100, Math.max(50, v));
  setThreshold.value = v;
  saveSettings({ swapThreshold: v });
});

setProxy.addEventListener('change', async () => {
  const endpoint = setProxy.checked ? '/api/proxy/start' : '/api/proxy/stop';
  showToast(setProxy.checked ? 'Starting proxy...' : 'Stopping proxy...', 'loading');
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const p = await res.json();
    if (!res.ok) throw new Error(p.error || 'Proxy toggle failed');
    proxyConfigSnippet = p.configSnippet || proxyConfigSnippet;
    proxySnippet.textContent = proxyConfigSnippet;
    renderProxyDetail(p);
    showToast(p.running ? 'Proxy started' : 'Proxy stopped', 'success');
  } catch (e) {
    setProxy.checked = !setProxy.checked; // revert
    renderProxyDetail({ running: setProxy.checked });
    showToast(`Error: ${e.message}`, 'error');
  }
});

btnCopySnippet.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(proxyConfigSnippet);
    showToast('Config snippet copied', 'success');
  } catch (e) {
    showToast('Copy failed', 'error');
  }
});

// Connect to Server-Sent Events for real-time dashboard updates
function connectSSE() {
  const eventSource = new EventSource('/api/status/events');
  
  eventSource.onmessage = (event) => {
    if (event.data === 'update') {
      updateDashboard(true);
    }
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE connection lost, reconnecting...', err);
  };
}

// Auto Refresh loops
setInterval(refreshActiveUsage, 30000); // Update active usage stats every 30s
setInterval(() => updateDashboard(true), 300000); // Full status refresh fallback every 5m

// Initial load & SSE connection
updateDashboard();
connectSSE();
