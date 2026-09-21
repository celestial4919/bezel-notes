<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { moveWindow, Position } from '@tauri-apps/plugin-positioner';
  import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { invoke } from '@tauri-apps/api/core';
  import Database from '@tauri-apps/plugin-sql';
  import { check, type Update } from '@tauri-apps/plugin-updater';

  interface Note {
    id: number;
    content: string;
    color_bg: string;
    color_accent: string;
    pinned: boolean;
    created_at: string;
  }

  const PASTEL_COLORS = [
    { bg: "#fef08a", accent: "#ca8a04" },
    { bg: "#fed7aa", accent: "#c2410c" },
    { bg: "#fbcfe8", accent: "#db2777" },
    { bg: "#e9d5ff", accent: "#9333ea" },
    { bg: "#bae6fd", accent: "#0284c7" },
    { bg: "#bbf7d0", accent: "#16a34a" }
  ];

  // Edge Notes is a native edge surface, not a permanent sidebar.
  // The collapsed window is only the invisible trigger strip; the expanded
  // window is the actual 260px panel. The OS hit-test area therefore stays
  // tiny while Edge Notes is dormant.
  const COLLAPSED_WIDTH = 6;
  const EXPANDED_WIDTH = 260;
  const BASELINE_PANEL_HEIGHT = 800;
  const BASELINE_SCALE = 1.25;

  // Keep the interaction forgiving without making the panel feel sticky.
  const HOVER_DELAY_MS = 120;
  const COLLAPSE_DELAY_MS = 180;

  let isHovering = $state(false);

  const appWindow = getCurrentWindow();

  // Bezel Notes licensing configuration. These identifiers are public
  // Keygen resource IDs; no privileged Keygen token is embedded in the app.
  const KEYGEN_ACCOUNT_ID = "0347e434-026d-4b2e-bb12-404c538c19a2";
  const KEYGEN_PRODUCT_ID = "1bd3c267-b7e5-4f1a-bf38-28bd01ce8927";
  const KEYGEN_POLICY_ID = "e8bc0da3-a531-4492-9ccf-c20c75206c5f";
  const LICENSE_STORAGE_KEY = "bezel_notes_license_key";

  let licenseKey = $state("");
  let isLicensed = $state(false);
  let licenseChecking = $state(true);
  let licenseBusy = $state(false);
  let licenseError = $state("");

  let db: Database;
  let searchQuery = $state("");
  let isExpanded = $state(false);
  let notes = $state<Note[]>([]);
  let PANEL_HEIGHT = BASELINE_PANEL_HEIGHT;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  let scaleUnlisten: (() => void) | undefined;

  // Updates stay completely dormant until the panel is actually summoned.
  // One check per app session keeps the edge surface silent and avoids
  // unnecessary network traffic while the app is idle.
  let availableUpdate = $state<Update | null>(null);
  let checkingUpdate = $state(false);
  let installingUpdate = $state(false);
  let updateChecked = false;

  // Build a completely render-safe snapshot before it reaches the template.
  // No sparse/undefined entries, no shared-object mutation, and no keyed each
  // block dependency on a potentially stale item reference.
  let filteredNotes = $derived.by(() => {
    const query = searchQuery.toLowerCase();

    return notes
      .filter((note): note is Note => Boolean(note) && typeof note === 'object')
      .map(note => ({
        id: Number(note.id),
        content: typeof note.content === 'string' ? note.content : '',
        color_bg: typeof note.color_bg === 'string' && note.color_bg.trim()
          ? note.color_bg
          : '#fef08a',
        color_accent: typeof note.color_accent === 'string' && note.color_accent.trim()
          ? note.color_accent
          : '#ca8a04',
        pinned: Boolean(note.pinned),
        created_at: typeof note.created_at === 'string' ? note.created_at : ''
      } satisfies Note))
      .filter(note => note.content.toLowerCase().includes(query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
  });

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      submitSearch();
    }
  }

  function submitSearch() {
    (document.activeElement as HTMLElement | null)?.blur();
  }

  async function getDpiAwarePanelHeight() {
    try {
      // 125% is our reference point: at 125% Edge Notes should be
      // exactly 800 logical CSS px tall. Other Windows scaling levels
      // are derived from that same reference so the physical size stays
      // visually consistent across 100%, 125%, 150%, and 175%.
      const monitor = await currentMonitor();
      if (monitor) {
        const scale = Number.isFinite(monitor.scaleFactor) && monitor.scaleFactor > 0
          ? monitor.scaleFactor
          : BASELINE_SCALE;

        const desiredLogicalHeight = Math.round(
          BASELINE_PANEL_HEIGHT * (BASELINE_SCALE / scale)
        );

        // Respect the monitor's usable work area. Tauri exposes work-area
        // geometry in physical pixels, so convert it to logical pixels
        // before comparing it with our LogicalSize height.
        const logicalWorkArea = monitor.workArea.size.toLogical(scale);
        if (Number.isFinite(logicalWorkArea.height) && logicalWorkArea.height > 0) {
          return Math.min(desiredLogicalHeight, Math.floor(logicalWorkArea.height));
        }

        return desiredLogicalHeight;
      }
    } catch (e) {
      console.warn("DPI monitor lookup failed; using viewport fallback:", e);
    }

    // Browser fallback: estimate the current scale from devicePixelRatio.
    const scale = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : BASELINE_SCALE;
    const desiredLogicalHeight = Math.round(
      BASELINE_PANEL_HEIGHT * (BASELINE_SCALE / scale)
    );
    const availableLogicalHeight = Math.max(400, window.innerHeight || desiredLogicalHeight);
    return Math.min(desiredLogicalHeight, Math.floor(availableLogicalHeight));
  }

  async function dockWindow(width: number) {
    try {
      PANEL_HEIGHT = await getDpiAwarePanelHeight();

      await appWindow.setSize(new LogicalSize(width, PANEL_HEIGHT));
      // Keep the positioning behavior from our known-good build.
      await moveWindow(Position.RightCenter);
    } catch (e) {
      console.error("Window docking error:", e);
    }
  }

  type KeygenResponse = {
    meta?: {
      valid?: boolean;
      code?: string;
      detail?: string;
    };
    data?: {
      id?: string;
    };
    errors?: Array<{
      title?: string;
      detail?: string;
    }>;
  };

  function keygenError(body: KeygenResponse, fallback: string): string {
    return body.meta?.detail || body.errors?.[0]?.detail || fallback;
  }

  async function keygenRequest(
    url: string,
    options: RequestInit
  ): Promise<KeygenResponse> {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/vnd.api+json");
    headers.set("Accept", "application/vnd.api+json");

    const response = await fetch(url, {
      ...options,
      headers
    });

    const body = await response.json().catch(() => ({})) as KeygenResponse;

    if (!response.ok) {
      throw new Error(
        keygenError(body, `Licensing service returned HTTP ${response.status}.`)
      );
    }

    return body;
  }

  async function validateLicense(
    key: string,
    fingerprint: string
  ): Promise<KeygenResponse> {
    return keygenRequest(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses/actions/validate-key`,
      {
        method: "POST",
        body: JSON.stringify({
          meta: {
            key,
            scope: {
              fingerprint,
              product: KEYGEN_PRODUCT_ID,
              policy: KEYGEN_POLICY_ID
            }
          }
        })
      }
    );
  }

  async function activateMachine(
    key: string,
    licenseId: string,
    fingerprint: string
  ): Promise<KeygenResponse> {
    return keygenRequest(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/machines`,
      {
        method: "POST",
        headers: {
          Authorization: `License ${key}`
        },
        body: JSON.stringify({
          data: {
            type: "machines",
            attributes: {
              fingerprint,
              name: "Bezel Notes",
              platform: "windows"
            },
            relationships: {
              license: {
                data: {
                  type: "licenses",
                  id: licenseId
                }
              }
            }
          }
        })
      }
    );
  }

  async function checkStoredLicense(): Promise<void> {
    licenseChecking = true;
    licenseError = "";

    try {
      const storedKey = localStorage.getItem(LICENSE_STORAGE_KEY)?.trim();

      if (!storedKey) {
        licenseKey = "";
        isLicensed = false;
        return;
      }

      const fingerprint = await invoke<string>("get_machine_fingerprint");
      const validation = await validateLicense(storedKey, fingerprint);

      if (validation.meta?.valid) {
        licenseKey = storedKey;
        isLicensed = true;
        return;
      }

      licenseKey = storedKey;
      isLicensed = false;
      licenseError = validation.meta?.detail || "This license is not valid on this device.";
    } catch (error) {
      console.error("License check failed:", error);
      isLicensed = false;
      licenseError = "Unable to verify your Bezel Notes license. Check your internet connection and try again.";
    } finally {
      licenseChecking = false;
    }
  }

  async function activateLicense(): Promise<void> {
    const key = licenseKey.trim();

    if (!key) {
      licenseError = "Enter your Bezel Notes license key.";
      return;
    }

    licenseBusy = true;
    licenseError = "";

    try {
      const fingerprint = await invoke<string>("get_machine_fingerprint");
      const firstValidation = await validateLicense(key, fingerprint);

      if (firstValidation.meta?.valid) {
        localStorage.setItem(LICENSE_STORAGE_KEY, key);
        isLicensed = true;
        void checkForUpdates();
        return;
      }

      const code = firstValidation.meta?.code;
      const licenseId = firstValidation.data?.id;

      const canActivate =
        code === "FINGERPRINT_SCOPE_MISMATCH" ||
        code === "NO_MACHINES";

      if (!canActivate || !licenseId) {
        throw new Error(
          keygenError(firstValidation, "This license cannot be activated on this device.")
        );
      }

      await activateMachine(key, licenseId, fingerprint);

      const finalValidation = await validateLicense(key, fingerprint);

      if (!finalValidation.meta?.valid) {
        throw new Error(
          keygenError(
            finalValidation,
            "The license was activated but could not be verified."
          )
        );
      }

      localStorage.setItem(LICENSE_STORAGE_KEY, key);
      isLicensed = true;
      void checkForUpdates();
    } catch (error) {
      console.error("License activation failed:", error);
      licenseError = error instanceof Error
        ? error.message
        : "License activation failed.";
      isLicensed = false;
    } finally {
      licenseBusy = false;
    }
  }

  onMount(() => {
    let destroyed = false;

    void (async () => {
      try {
        // Start completely dormant. The only native footprint is the 6px
        // trigger strip at the right edge. The same DPI-aware height is kept so
        // the trigger occupies the full usable edge height without changing
        // the app's summon behavior.
        await dockWindow(COLLAPSED_WIDTH);
        if (destroyed) return;
        isExpanded = false;

        db = await Database.load("sqlite:notes.db");
        if (destroyed) return;
        await fetchNotes();
        if (destroyed) return;

        // Licensing is checked silently during startup. The notes panel remains
        // dormant at the edge while the verification happens.
        await checkStoredLicense();
        if (destroyed) return;

        // Windows can change DPI while the app is running (display scaling,
        // resolution changes, or moving the window across monitors). Recompute
        // the logical height when that happens. Re-docking preserves our
        // right-edge behavior and avoids clipping at 125/150/175%.
        const unlistenScale = await appWindow.onScaleChanged(async () => {
          try {
            await dockWindow(isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH);
          } catch (e) {
            console.error("Scale-change re-dock failed:", e);
          }
        });

        if (destroyed) {
          unlistenScale();
          return;
        }

        scaleUnlisten = unlistenScale;
      } catch (e) {
        if (!destroyed) {
          console.error("Initialization error:", e);
        }
      }
    })();

    return () => {
      destroyed = true;
      if (expandTimer) clearTimeout(expandTimer);
      if (collapseTimer) clearTimeout(collapseTimer);
      scaleUnlisten?.();
    };
  });

  async function checkForUpdates() {
    if (import.meta.env.DEV || updateChecked || checkingUpdate) return;

    updateChecked = true;
    checkingUpdate = true;

    try {
      availableUpdate = await check();
    } catch (e) {
      // Update checks are intentionally non-blocking. A network or endpoint
      // problem must never interfere with the note app itself.
      console.warn('Update check failed:', e);
      availableUpdate = null;
    } finally {
      checkingUpdate = false;
    }
  }

  async function installUpdate() {
    if (!availableUpdate || installingUpdate) return;

    installingUpdate = true;

    try {
      // On Windows, Tauri launches the updater installer and exits the current
      // app so the update can replace the installed files safely.
      await availableUpdate.downloadAndInstall();
    } catch (e) {
      console.error('Update installation failed:', e);
      installingUpdate = false;
    }
  }

  async function handleMouseEnter() {
    isHovering = true;

    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = undefined;
    }

    // A tiny hover delay prevents accidental edge brushes from opening the
    // panel while keeping the interaction effectively instant.
    if (expandTimer) clearTimeout(expandTimer);
    expandTimer = setTimeout(async () => {
      if (!isHovering || isExpanded) return;
      await dockWindow(EXPANDED_WIDTH);
      if (isHovering) {
        isExpanded = true;
        if (isLicensed) {
          void checkForUpdates();
        }
      }
    }, HOVER_DELAY_MS);
  }

  function handleMouseLeave() {
    isHovering = false;

    if (expandTimer) {
      clearTimeout(expandTimer);
      expandTimer = undefined;
    }

    // Give the cursor a small grace period to move back into the panel
    // before it collapses.
    if (collapseTimer) clearTimeout(collapseTimer);
    if (!isExpanded) return;

    isExpanded = false;
    collapseTimer = setTimeout(() => {
      void dockWindow(COLLAPSED_WIDTH);
    }, COLLAPSE_DELAY_MS);
  }

  function normalizeNote(row: any): Note | null {
    if (!row || typeof row !== 'object') return null;

    const id = Number(row.id);
    if (!Number.isFinite(id)) return null;

    return {
      id,
      content: typeof row.content === 'string' ? row.content : '',
      color_bg: typeof row.color_bg === 'string' && row.color_bg.trim() ? row.color_bg : '#fef08a',
      color_accent: typeof row.color_accent === 'string' && row.color_accent.trim() ? row.color_accent : '#ca8a04',
      pinned: Boolean(row.pinned),
      created_at: typeof row.created_at === 'string' ? row.created_at : ''
    };
  }

  async function ensureDatabase(): Promise<Database> {
    if (db) return db;

    db = await Database.load("sqlite:notes.db");
    return db;
  }

  async function fetchNotes() {
    try {
      const database = await ensureDatabase();
      const res = await database.select<any[]>("SELECT * FROM notes ORDER BY pinned DESC, id DESC");
      notes = res.map(normalizeNote).filter((note): note is Note => note !== null);
    } catch (e) {
      console.error("Failed to load notes:", e);
    }
  }

  async function addNote() {
    try {
      const database = await ensureDatabase();
      const color = PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];
      const timeStr = new Date().toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

      await database.execute(
        "INSERT INTO notes (content, color_bg, color_accent, pinned, created_at) VALUES (?, ?, ?, ?, ?)",
        ["", color.bg, color.accent, 0, timeStr]
      );

      await fetchNotes();
    } catch (e) {
      console.error("Failed to add note:", e);
    }
  }

  async function updateContent(id: number, content: string) {
    if (!db) return;
    await db.execute("UPDATE notes SET content = ? WHERE id = ?", [content, id]);
  }

  async function cycleColor(id: number, currentBg: string) {
    if (!db) return;
    const currentIndex = PASTEL_COLORS.findIndex(c => c.bg === currentBg);
    const nextColor = PASTEL_COLORS[(currentIndex + 1) % PASTEL_COLORS.length];

    await db.execute(
      "UPDATE notes SET color_bg = ?, color_accent = ? WHERE id = ?",
      [nextColor.bg, nextColor.accent, id]
    );
    await fetchNotes();
  }

  async function togglePin(id: number, currentPinned: boolean) {
    if (!db) return;
    await db.execute("UPDATE notes SET pinned = ? WHERE id = ?", [currentPinned ? 0 : 1, id]);
    await fetchNotes();
  }

  async function deleteNote(id: number) {
    if (!db) return;
    await db.execute("DELETE FROM notes WHERE id = ?", [id]);
    await fetchNotes();
  }

  // WebView2 on some Windows builds enforces a native "classic" scrollbar
  // theme that ignores ::-webkit-scrollbar-button CSS entirely, so the
  // native up/down arrows can't be removed via stylesheet alone. Instead we
  // hide the native scrollbar completely (well-supported, unlike hiding just
  // its button) and draw our own thin thumb here, driven by real scroll
  // position - this sidesteps the broken native rendering entirely.
  function scrollThumb(textareaEl: HTMLTextAreaElement) {
    const thumb = textareaEl.nextElementSibling as HTMLElement | null;
    if (!thumb) return;

    function update() {
      const { scrollTop, scrollHeight, clientHeight } = textareaEl;
      if (!thumb) return;
      if (scrollHeight <= clientHeight + 1) {
        thumb.style.opacity = '0';
        return;
      }
      thumb.style.opacity = '1';
      const thumbHeight = Math.max((clientHeight / scrollHeight) * clientHeight, 14);
      const maxTop = clientHeight - thumbHeight;
      const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.top = `${thumbTop}px`;
    }

    textareaEl.addEventListener('scroll', update);
    textareaEl.addEventListener('input', update);
    window.addEventListener('resize', update);
    update();

    return {
      destroy() {
        textareaEl.removeEventListener('scroll', update);
        textareaEl.removeEventListener('input', update);
        window.removeEventListener('resize', update);
      }
    };
  }

  let notesFeedEl = $state<HTMLElement>();
  let listThumbEl = $state<HTMLElement>();
  let listHideTimer: ReturnType<typeof setTimeout> | undefined;

  function updateListThumb() {
    if (!notesFeedEl || !listThumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = notesFeedEl;
    if (scrollHeight <= clientHeight + 1) {
      listThumbEl.style.opacity = '0';
      return;
    }
    const thumbHeight = Math.max((clientHeight / scrollHeight) * clientHeight, 20);
    const maxTop = clientHeight - thumbHeight;
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    listThumbEl.style.height = `${thumbHeight}px`;
    listThumbEl.style.top = `${thumbTop}px`;
  }

  function handleListScroll() {
    updateListThumb();
    if (!listThumbEl) return;
    listThumbEl.style.opacity = '1';
    if (listHideTimer) clearTimeout(listHideTimer);
    listHideTimer = setTimeout(() => {
      if (listThumbEl) listThumbEl.style.opacity = '0';
    }, 800);
  }
</script>

<div
  class="sidebar"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  role="region"
  aria-label="Edge Notes Panel"
>
  {#if isExpanded}
    {#if licenseChecking}
      <div class="license-screen" transition:fade={{ duration: 150 }}>
        <div class="license-box">
          <div class="license-title">Bezel Notes</div>
          <div class="license-status">Checking license...</div>
        </div>
      </div>
    {:else if !isLicensed}
      <div class="license-screen" transition:fade={{ duration: 150 }}>
        <div class="license-box">
          <div class="license-title">Activate Bezel Notes</div>
          <div class="license-subtitle">
            Enter your license key to continue.
          </div>

          <input
            class="license-input"
            type="text"
            bind:value={licenseKey}
            placeholder="Enter license key"
            disabled={licenseBusy}
            autocomplete="off"
            spellcheck="false"
            onkeydown={(event) => {
              if (event.key === "Enter") {
                void activateLicense();
              }
            }}
          />

          <button
            class="license-button"
            onclick={activateLicense}
            disabled={licenseBusy}
          >
            {licenseBusy ? "Activating..." : "Activate"}
          </button>

          {#if licenseError}
            <div class="license-error">
              {licenseError}
            </div>
          {/if}
        </div>
      </div>
    {:else}
    <div class="panel-content" transition:fade={{ duration: 150 }}>
      <header class="top-bar">
        <button class="add-btn" onclick={addNote} title="Add Note" aria-label="Add Note">+</button>
        <div class="search-container">
          <input
            type="text"
            placeholder="Search notes..."
            bind:value={searchQuery}
            onkeydown={handleSearchKeydown}
            class="search-input"
          />
          <button class="search-icon-btn" type="button" onclick={submitSearch} title="Search" aria-label="Search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </button>
        </div>
      </header>

      <div class="notes-feed-wrapper">
        <main class="notes-feed" bind:this={notesFeedEl} onscroll={handleListScroll}>
        {#each filteredNotes as note, index}
          {#if note}
          <div
            class="card"
            style:background-color={note.color_bg}
            style:border-color={note.color_accent}
            style:z-index={filteredNotes.length - index}
          >
            <div class="card-header">
              <div class="dots" style:color={note.color_accent} aria-label="Edge Notes logo">
                  <span></span>
                  <span></span>
                  <span></span>
             </div>
              <div class="actions" style:color={note.color_accent}>
                <button
                  class="icon-btn palette-btn"
                  onclick={() => cycleColor(note.id, note.color_bg)}
                  title="Change color"
                  aria-label="Change color"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5 l3.54 3.54 a5 5 0 1 1 -7.07 0 Z" fill="currentColor" opacity="0.55"></path>
                    <path d="M15 4 l4.6 4.6 a6.5 6.5 0 1 1 -9.19 0 Z" fill="currentColor"></path>
                  </svg>
                </button>
                <button
                  class:pinned={note.pinned}
                  class="icon-btn pin-btn"
                  onclick={() => togglePin(note.id, note.pinned)}
                  title={note.pinned ? "Unpin" : "Pin"}
                  aria-label={note.pinned ? "Unpin" : "Pin"}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 3h8l-1 6 3 3v2h-5v7l-1 1-1-1v-7H6v-2l3-3-1-6Z"></path>
                  </svg>
                </button>
                <button
                  class="icon-btn delete-btn"
                  onclick={() => deleteNote(note.id)}
                  title="Delete"
                  aria-label="Delete"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7l10 10M17 7L7 17"></path>
                  </svg>
                </button>
              </div>
            </div>

            <div class="card-text-wrapper">
              <textarea
                bind:value={note.content}
                oninput={() => updateContent(note.id, note.content)}
                class="card-text"
                rows="2"
                placeholder="Type your note here..."
                use:scrollThumb
              ></textarea>
              <div class="custom-thumb"></div>
            </div>

            <footer class="card-footer" style:color={note.color_accent}>
              {note.created_at}
            </footer>
          </div>
          {/if}
        {:else}
          <div class="empty-state">
            <svg viewBox="0 0 64 64" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="14" y="10" width="30" height="38" rx="3"></rect>
              <line x1="20" y1="20" x2="38" y2="20"></line>
              <line x1="20" y1="28" x2="38" y2="28"></line>
              <circle cx="44" cy="44" r="9"></circle>
              <line x1="50.5" y1="50.5" x2="56" y2="56"></line>
            </svg>
            <p>No notes found</p>
          </div>
        {/each}
      </main>
        <div class="list-thumb" bind:this={listThumbEl}></div>
      </div>

      {#if availableUpdate}
        <button
          class="update-btn"
          onclick={installUpdate}
          disabled={installingUpdate}
          aria-label={installingUpdate ? 'Installing update' : `Update to ${availableUpdate.version}`}
        >
          {installingUpdate ? 'Updating…' : `Update ${availableUpdate.version}`}
        </button>
      {/if}

      <footer class="branding-footer">
      Bezel // Celestial Forge
      </footer>
    </div>
    {/if}
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: transparent !important;
    width: 100vw;
    height: 100vh;
  }

  .sidebar {
    width: 100%;
    height: 100vh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    /* Balanced top/bottom padding so content never touches the screen edges */
    /* In expanded mode this keeps content clear of the screen edge.
       In collapsed mode the native window is only 6px wide, so there is no
       visible UI and no large transparent hit-test surface. */
    padding: 32px 0px 32px 8px;
    background: transparent;
    color: #e5e7eb;
    font-family: 'Segoe UI', system-ui, sans-serif;
    user-select: none;
    overflow: hidden;
  }

  .panel-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .top-bar {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    width: 100%;
  }

  .add-btn {
    background: #f3f4f6;
    border: 1px solid rgba(31, 41, 55, 0.25);
    box-shadow: none;
    height: 34px;
    box-sizing: border-box;
    min-width: 64px;
    padding: 0 18px;
    margin: 0 auto;
    border-radius: 999px;
    color: #1f2937;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .add-btn:hover {
    background: #e5e7eb;
    transform: scale(1.05);
  }

  .add-btn:focus-visible {
    outline: 2px solid #9ca3af;
    outline-offset: 2px;
  }

  .search-container {
    display: flex;
    align-items: center;
    background: #f3f4f6;
    border: 1px solid rgba(31, 41, 55, 0.25);
    border-radius: 14px;
    box-shadow: none;
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    width: 190px;
  }

  .search-icon-btn {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0;
    margin-left: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #1f2937;
    cursor: pointer;
    flex-shrink: 0;
  }

  .search-icon-btn:hover {
    color: #000000;
  }

  .search-input {
    border: none;
    background: transparent;
    width: 100%;
    font-size: 12px;
    color: #1f2937;
    outline: none;
  }

  .notes-feed-wrapper {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .notes-feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding-left: 8px;
    padding-right: 14px;
    padding-top: 6px;
    scrollbar-width: none;
  }

  .notes-feed::-webkit-scrollbar {
    width: 0;
    display: none;
  }

  .list-thumb {
    position: absolute;
    right: 2px;
    top: 0;
    width: 4px;
    border-radius: 999px;
    background: rgba(31, 41, 55, 0.45);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .card {
  border: 0px solid;
  border-radius: 0px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  --icon-color: var(--card-accent);

  width: 220px;      /* 220 + 30 + 30 */
  min-height: 160px; /* square note */
  align-self: center;

  position: relative;
  margin-top: -20px;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  box-shadow:
    3px 4px 8px rgba(0, 0, 0, 0.12),
    0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .card:first-child {
    margin-top: 0;
  }

  .card:hover {
    z-index: 9999 !important;
    transform: translateY(-2px);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .dots {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: -3px;
  }

  .dots span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    display: block;
  } 

  .actions {
    display: flex;
    gap: 4px;
  }

  .actions button {
    background: none;
    border: none;
    box-shadow: none;
    cursor: pointer;
    padding: 2px;
  }

  .icon-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: inherit;
  }

  .icon-btn svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon-btn:hover {
    opacity: 0.7;
  }

  .palette-btn {
    width: 25px;
    height: 25px;
  }

  .palette-btn svg {
    width: 17px;
    height: 17px;
    margin-top: -5px;
  }

  .pin-btn {
    color: #9ca3af;
  }

  .pin-btn:hover {
    color: #6b7280;
  }

  .icon-btn.pinned {
    color: #ef4444;
  }

  .icon-btn.pinned:hover {
    color: #dc2626;
  }

  .delete-btn svg {
    fill: none;
    stroke-width: 2;
  }

  .card-text-wrapper {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .card-text {
    background: transparent;
    border: none;
    box-shadow: none;
    resize: none;
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    font-size: 13px;
    line-height: 1.3;
    color: #1f2937;
    outline: none;
    font-family: inherit;
    margin: 4px 0;
    scrollbar-width: none;
  }

  .card-text::-webkit-scrollbar {
    width: 0;
    display: none;
  }

  .custom-thumb {
    position: absolute;
    right: -2px;
    top: 0;
    width: 4px;
    border-radius: 999px;
    background: rgba(31, 41, 55, 0.35);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .card-text::placeholder {
    color: rgba(31, 41, 55, 0.45);
    font-style: italic;
  }

  .card-footer {
    font-size: 10px;
    font-style: italic;
    text-align: right;
    margin-top: auto;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: #6b7280;
    text-align: center;
    margin-top: 24px;
  }

  .empty-state svg {
    opacity: 0.7;
  }

  .empty-state p {
    font-size: 12px;
    margin: 0;
  }

  .license-screen {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    box-sizing: border-box;
  }

  .license-box {
    width: 210px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: #1f2937;
  }

  .license-title {
    font-size: 18px;
    font-weight: 700;
  }

  .license-status,
  .license-subtitle {
    font-size: 12px;
    color: #6b7280;
    line-height: 1.4;
  }

  .license-input {
    width: 100%;
    height: 34px;
    box-sizing: border-box;
    border: 1px solid rgba(31, 41, 55, 0.25);
    border-radius: 10px;
    padding: 0 10px;
    outline: none;
    font-family: inherit;
    font-size: 12px;
    color: #1f2937;
    background: #f3f4f6;
  }

  .license-input:focus {
    border-color: #6b7280;
  }

  .license-button {
    height: 34px;
    border: none;
    border-radius: 10px;
    background: #1f2937;
    color: #ffffff;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
  }

  .license-button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .license-error {
    font-size: 11px;
    line-height: 1.4;
    color: #dc2626;
    overflow-wrap: anywhere;
  }

  .update-btn {
    align-self: center;
    border: 1px solid rgba(31, 41, 55, 0.18);
    border-radius: 999px;
    background: rgba(243, 244, 246, 0.92);
    color: #1f2937;
    padding: 5px 11px;
    margin-top: 4px;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
  }

  .update-btn:hover:not(:disabled) {
    background: #ffffff;
    transform: translateY(-1px);
  }

  .update-btn:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .branding-footer {
    text-align: center;
    font-size: 11px;
    font-style: italic;
    color: #9ca3af;
    padding-top: 8px;
  }

  /* Defense-in-depth: if the panel ever ends up shorter than expected (an
     unusual screen/DPI combination we haven't seen), tighten spacing rather
     than let the add button or footer clip off-screen. This can't rescue a
     window that's literally taller than the physical screen (that's a
     native sizing problem, not a CSS one) - but it does make the layout
     itself gracefully compress instead of breaking. */
  @media (max-height: 900px) {
    .sidebar {
      padding: 12px 0px 12px 8px;
    }

    .top-bar {
      margin-bottom: 6px;
    }

    .branding-footer {
      padding-top: 4px;
      font-size: 10px;
    }
  }
</style>