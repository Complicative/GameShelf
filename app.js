const gameGrid = document.querySelector('#game-grid');
const categoryFilters = document.querySelector('#category-filters');
const dialog = document.querySelector('#details');
const content = document.querySelector('#detail-content');
const appLayout = document.querySelector('.app-layout');
const filterPanel = document.querySelector('#category-filter-panel');
const filterPanelToggle = document.querySelector('#filter-panel-toggle');
let games = [];
let selectedTaxonomy = new Set();
let selectedLanguages = new Set();
let requireAllTaxonomy = false;
let playerValue = 0;
let playerMode = 'minimum';
let timeValue = 0;
let timeMode = 'maximum';
let timeCeiling = 0;
const taxonomyLogicButton = document.querySelector('#taxonomy-logic');
function updateFilterPanel() {
  const isCollapsed = appLayout.classList.contains('filter-collapsed');
  filterPanelToggle.textContent = isCollapsed ? '»' : '«';
  filterPanelToggle.classList.toggle('is-open', !isCollapsed);
  filterPanelToggle.setAttribute('aria-expanded', String(!isCollapsed));
  filterPanelToggle.setAttribute('aria-label', `${isCollapsed ? 'Show' : 'Hide'} category and mechanic filters`);
  filterPanelToggle.title = `${isCollapsed ? 'Show' : 'Hide'} filters`;
  filterPanel.setAttribute('aria-hidden', String(isCollapsed));
  filterPanel.inert = isCollapsed;
}

function getVisibleColumnCount() {
  const cards = [...gameGrid.children].filter(element => element.classList.contains('game'));
  if (!cards.length) return 1;
  const firstRowTop = cards[0].getBoundingClientRect().top;
  return cards.filter(card => Math.abs(card.getBoundingClientRect().top - firstRowTop) < 1).length;
}

filterPanelToggle.addEventListener('click', () => {
  const willExpand = appLayout.classList.contains('filter-collapsed');
  if (willExpand) {
    gameGrid.style.gridTemplateColumns = `repeat(${getVisibleColumnCount()}, minmax(0, 1fr))`;
  } else {
    gameGrid.style.gridTemplateColumns = '';
  }
  appLayout.classList.toggle('filter-collapsed');
  updateFilterPanel();
});
updateFilterPanel();

document.querySelector('#close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const range = (a,b) => a && b ? (a === b ? a : `${a}–${b}`) : (a || b || 'Unknown');
const minutes = game => game.minTime && game.maxTime && game.minTime !== game.maxTime ? `${game.minTime}–${game.maxTime} min` : game.time ? `${game.time} min` : 'Unknown time';
const languageOptions = [
  { name: 'English', flag: '🇬🇧' },
  { name: 'German', flag: '🇩🇪' }
];
const languageFilters = document.querySelector('#language-filters');
const img = (url, title, className) => url ? `<img class="${className}" src="${escapeHTML(url)}" alt="${escapeHTML(title)} cover" loading="lazy">` : `<div class="${className}" role="img" aria-label="No cover available"></div>`;
const tags = arr => arr.map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('');
const fact = (label, value) => `<div class="fact"><span class="fact-label">${escapeHTML(label)}</span><span class="fact-value">${escapeHTML(value)}</span></div>`;

function languageFlags(languages) {
  return languageOptions
    .filter(language => languages.includes(language.name))
    .map(language => `<span class="language-flag" role="img" aria-label="${language.name}" title="${language.name}">${language.flag}</span>`)
    .join('');
}

async function saveCustomName(game, input, button) {
  try {
    button.disabled = true;
    const payload = { gameId: game.id, customName: input.value.trim() };
    const response = await fetch('/api/custom-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    game.customName = result.customName || '';
    game.name = game.customName || game.originalName || game.name;
    button.textContent = 'Saved';
    await load();
    dialog.close();
  } catch (error) {
    button.textContent = 'Save failed';
    input.focus();
    setTimeout(() => { button.textContent = 'Save'; }, 1500);
    console.error(error);
  } finally {
    button.disabled = false;
  }
}

async function saveLanguages(game, button) {
  try {
    button.disabled = true;
    const languages = [...document.querySelectorAll('.language-choice[aria-pressed="true"]')]
      .map(option => option.dataset.language);
    const response = await fetch('/api/custom-languages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: game.id, languages })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    game.languages = result.languages;
    button.textContent = 'Saved';
    await load();
    setTimeout(() => { button.textContent = 'Save languages'; }, 1200);
  } catch (error) {
    console.error(error);
    button.textContent = 'Save failed';
    setTimeout(() => { button.textContent = 'Save languages'; }, 1800);
  } finally {
    button.disabled = false;
  }
}

function renderCustomCategories(game) {
  const list = document.querySelector('#custom-category-list');
  list.innerHTML = game.customCategories.map(category =>
    `<button type="button" class="custom-category tag" data-category="${escapeHTML(category)}" aria-label="Remove custom category ${escapeHTML(category)}">${escapeHTML(category)} <span aria-hidden="true">×</span></button>`
  ).join('');
}

async function saveCustomCategories(game, customCategories, input, button) {
  try {
    button.disabled = true;
    const response = await fetch('/api/custom-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: game.id, customCategories })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    game.customCategories = result.customCategories;
    game.categories = [...new Set([...game.apiCategories, ...game.customCategories])];
    renderCustomCategories(game);
    input.value = '';
    await load();
  } catch (error) {
    console.error(error);
    input.setCustomValidity(error.message);
    input.reportValidity();
  } finally {
    button.disabled = false;
  }
}

function openGame(game) {
  const selectedLanguages = Array.isArray(game.languages) ? game.languages : [];
  content.innerHTML = `<div class="detail-layout">
    <div>${img(game.image || game.thumbnail, game.name, 'detail-cover')}</div>
    <div><h2 class="detail-title" id="detail-title">${escapeHTML(game.name)}</h2>
      <p class="year">${game.year ? escapeHTML(game.year) : 'Board game'}</p>
      <div class="facts">${fact('Players',range(game.minPlayers,game.maxPlayers))}${fact('Playtime',minutes(game))}${fact('BGG average',game.rating ? `${Number(game.rating).toFixed(1)} / 10` : 'Not rated')}${fact('Complexity',game.weight ? `${Number(game.weight).toFixed(2)} / 5` : 'Not rated')}${fact('Minimum age',game.minAge ? `${game.minAge}+` : 'Unknown')}</div>
      <div class="custom-name-panel">
        <label for="custom-name-input" class="custom-name-label">Custom name</label>
        <div class="custom-name-row">
          <input id="custom-name-input" class="custom-name-input" type="text" maxlength="120" value="${escapeHTML(game.customName || game.originalName || game.name)}" placeholder="Use a personal label for this game">
          <button id="save-custom-name" type="button" class="custom-name-save">Save</button>
        </div>
      </div>
      <div class="language-panel">
        <h3 class="custom-name-label">Languages supported</h3>
        <div class="language-options" role="group" aria-label="Select supported languages">
          ${languageOptions.map(language => `<button type="button" class="language-choice${selectedLanguages.includes(language.name) ? ' is-selected' : ''}" data-language="${language.name}" aria-pressed="${selectedLanguages.includes(language.name)}"><span aria-hidden="true">${language.flag}</span> ${language.name}</button>`).join('')}
        </div>
        <button id="save-languages" type="button" class="custom-name-save">Save languages</button>
      </div>
      <div class="custom-category-panel">
        <label for="custom-category-input" class="custom-name-label">Add custom categories</label>
        <div class="custom-name-row">
          <input id="custom-category-input" class="custom-name-input" type="text" maxlength="80" placeholder="Enter a category">
          <button id="add-custom-category" type="button" class="custom-name-save">Add</button>
        </div>
        <div id="custom-category-list" class="custom-category-list" aria-label="Custom categories"></div>
      </div>
      ${game.categories.length ? `<h3 class="section-title">Categories</h3><div class="tags">${tags(game.categories)}</div>` : ''}
      ${game.mechanics.length ? `<h3 class="section-title">Mechanics</h3><div class="tags">${tags(game.mechanics)}</div>` : ''}
      ${game.designers.length ? `<h3 class="section-title">Designers</h3><div class="detail-text">${escapeHTML(game.designers.join(', '))}</div>` : ''}
    </div>
  </div>
  ${game.description ? `<h3 class="section-title">About the game</h3><div class="detail-text">${escapeHTML(game.description)}</div>` : ''}
  <div class="credit">Data from <a href="https://boardgamegeek.com/boardgame/${encodeURIComponent(game.id)}" target="_blank" rel="noopener noreferrer">BoardGameGeek</a></div>`;
  const input = document.querySelector('#custom-name-input');
  const button = document.querySelector('#save-custom-name');
  button.addEventListener('click', () => saveCustomName(game, input, button));
  content.querySelectorAll('.language-choice').forEach(option => {
    option.addEventListener('click', () => {
      const selected = option.getAttribute('aria-pressed') !== 'true';
      option.setAttribute('aria-pressed', String(selected));
      option.classList.toggle('is-selected', selected);
    });
  });
  document.querySelector('#save-languages').addEventListener('click', event => saveLanguages(game, event.currentTarget));
  const categoryInput = document.querySelector('#custom-category-input');
  const addCategoryButton = document.querySelector('#add-custom-category');
  renderCustomCategories(game);
  const addCategory = () => {
    categoryInput.setCustomValidity('');
    const category = categoryInput.value.trim();
    if (!category || game.customCategories.some(existing => existing.toLocaleLowerCase() === category.toLocaleLowerCase())) return;
    saveCustomCategories(game, [...game.customCategories, category], categoryInput, addCategoryButton);
  };
  addCategoryButton.addEventListener('click', addCategory);
  categoryInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addCategory();
    }
  });
  document.querySelector('#custom-category-list').addEventListener('click', event => {
    const removeButton = event.target.closest('button[data-category]');
    if (!removeButton) return;
    const category = removeButton.dataset.category;
    saveCustomCategories(game, game.customCategories.filter(existing => existing !== category), categoryInput, addCategoryButton);
  });
  dialog.showModal();
}

function gameTaxonomy(game) {
  return [...new Set([...game.categories, ...game.mechanics])];
}

function renderFilterList(container, values, selectedValues, countGames) {
  container.replaceChildren();
  const sortedValues = values
    .map(value => ({ value, count: countGames(value) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  for (const { value, count } of sortedValues) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'filter-option';
    option.classList.toggle('is-selected', selectedValues.has(value));
    option.setAttribute('aria-pressed', String(selectedValues.has(value)));
    option.dataset.filterValue = value;
    const text = document.createElement('span');
    text.className = 'filter-option-text';
    text.textContent = `${value} (${count})`;
    option.append(text);
    container.append(option);
  }
}

function renderFilters() {
  const taxonomy = [...new Set(games.flatMap(gameTaxonomy))];
  selectedTaxonomy = new Set([...selectedTaxonomy].filter(value => taxonomy.includes(value)));
  renderFilterList(categoryFilters, taxonomy, selectedTaxonomy,
    value => games.filter(game => gameTaxonomy(game).includes(value)).length);
  languageFilters.replaceChildren();
  for (const language of languageOptions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'language-filter-option';
    option.classList.toggle('is-selected', selectedLanguages.has(language.name));
    option.setAttribute('aria-pressed', String(selectedLanguages.has(language.name)));
    option.setAttribute('aria-label', language.name);
    option.dataset.language = language.name;
    option.innerHTML = `<span aria-hidden="true">${language.flag}</span><span>${language.name}</span>`;
    languageFilters.append(option);
  }
}

function updateTaxonomyLogicButton() {
  const mode = requireAllTaxonomy ? 'AND' : 'OR';
  const label = `Match ${requireAllTaxonomy ? 'all' : 'any'} categories and mechanics (${mode})`;
  taxonomyLogicButton.textContent = mode;
  taxonomyLogicButton.setAttribute('aria-label', label);
  taxonomyLogicButton.title = label;
  taxonomyLogicButton.setAttribute('aria-pressed', String(requireAllTaxonomy));
}

function renderGames() {
  const filteredGames = games.filter(game => {
    if (selectedLanguages.size && !(game.languages || []).some(language => selectedLanguages.has(language))) return false;
    if (playerValue > 0) {
      const supportedMin = Number(game.minPlayers);
      const supportedMax = Number(game.maxPlayers);
      if (playerMode === 'minimum' && (!supportedMax || supportedMax < playerValue)) return false;
      if (playerMode === 'exact' && (!supportedMin || !supportedMax || supportedMin > playerValue || supportedMax < playerValue)) return false;
    }
    if (timeValue > 0 && !(timeMode === 'maximum' && timeValue >= timeCeiling)) {
      const supportedMin = Number(game.minTime) || Number(game.time);
      const supportedMax = Number(game.maxTime) || Number(game.time);
      if (timeMode === 'minimum' && (!supportedMax || supportedMax < timeValue)) return false;
      if (timeMode === 'maximum' && (!supportedMin || supportedMin > timeValue)) return false;
    }
    if (!selectedTaxonomy.size) return true;
    const matches = gameTaxonomy(game).filter(value => selectedTaxonomy.has(value)).length;
    return requireAllTaxonomy ? matches === selectedTaxonomy.size : matches > 0;
  });
  if (!filteredGames.length) {
    gameGrid.innerHTML = `<p class="message">${games.length ? 'No games match the selected filters.' : 'No owned games found in this collection.'}</p>`;
    return;
  }
  gameGrid.replaceChildren();
  for (const game of filteredGames) {
    const card = document.createElement('article');
    card.className = 'game';
    const playerRange = range(game.minPlayers, game.maxPlayers);
    const playtime = minutes(game).replace(/ min$/, '');
    const taxonomyOptions = gameTaxonomy(game).slice(0, 4).map((value, index) =>
      `${index ? '<span class="card-taxonomy-separator" aria-hidden="true">·</span>' : ''}<button class="card-taxonomy-option${selectedTaxonomy.has(value) ? ' is-selected' : ''}" type="button" data-filter-value="${escapeHTML(value)}" aria-pressed="${selectedTaxonomy.has(value)}">${escapeHTML(value)}</button>`
    ).join('');
    card.innerHTML = `<button class="game-main" type="button" aria-label="View details for ${escapeHTML(game.name)}">${img(game.image || game.thumbnail, game.name, 'cover')}<div class="name">${escapeHTML(game.name)}</div><div class="meta"><span class="meta-item" aria-label="${escapeHTML(playerRange)} players"><svg class="meta-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.5" r="2.5"></circle><path d="M3 14v-1.5a5 5 0 0 1 10 0V14z"></path></svg><span>${escapeHTML(playerRange)}</span></span><span class="meta-item" aria-label="${escapeHTML(minutes(game))}"><svg class="meta-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"></circle><path d="M8 4v4l2.5 1.5"></path></svg><span>${escapeHTML(playtime)}</span></span><div class="game-languages" aria-label="Supported languages">${languageFlags(game.languages || [])}</div></div></button><div class="card-taxonomy" aria-label="Categories and mechanics">${taxonomyOptions}</div>`;
    card.querySelector('.game-main').addEventListener('click', () => openGame(game));
    gameGrid.append(card);
  }
}

function updateRangeValues() {
  document.querySelector('#player-value').textContent = playerValue === 0 ? 'Any' : String(playerValue);
  document.querySelector('#time-value').textContent = timeValue === 0 || (timeMode === 'maximum' && timeValue >= timeCeiling)
    ? 'Any'
    : String(timeValue);
}

function updateSingleRange(event) {
  if (event.currentTarget.id === 'player-value-input') {
    playerValue = Number(event.currentTarget.value);
  } else {
    timeValue = Number(event.currentTarget.value);
  }
  updateRangeValues();
  renderGames();
}

document.querySelector('#player-value-input').addEventListener('input', updateSingleRange);
document.querySelector('#time-value-input').addEventListener('input', updateSingleRange);

document.querySelector('#player-mode').addEventListener('click', event => {
  playerMode = playerMode === 'minimum' ? 'exact' : 'minimum';
  const button = event.currentTarget;
  button.textContent = playerMode === 'minimum' ? 'At least' : 'Exactly';
  button.setAttribute('aria-label', `Player filter mode: ${playerMode === 'minimum' ? 'At least' : 'Exactly'}`);
  renderGames();
});

document.querySelector('#time-mode').addEventListener('click', event => {
  const wasNeutral = timeValue === 0 || (timeMode === 'maximum' && timeValue >= timeCeiling);
  timeMode = timeMode === 'minimum' ? 'maximum' : 'minimum';
  if (wasNeutral) timeValue = timeMode === 'minimum' ? 0 : timeCeiling;
  const slider = document.querySelector('#time-value-input');
  slider.value = String(timeValue);
  const button = event.currentTarget;
  button.textContent = timeMode === 'minimum' ? 'Minimum' : 'Maximum';
  button.setAttribute('aria-label', `Play time filter mode: ${timeMode === 'minimum' ? 'Minimum' : 'Maximum'}`);
  updateRangeValues();
  renderGames();
});

languageFilters.addEventListener('click', event => {
  const option = event.target.closest('button[data-language]');
  if (!option) return;
  const language = option.dataset.language;
  const selected = !selectedLanguages.has(language);
  if (selected) selectedLanguages.add(language);
  else selectedLanguages.delete(language);
  option.classList.toggle('is-selected', selected);
  option.setAttribute('aria-pressed', String(selected));
  renderGames();
});

taxonomyLogicButton.addEventListener('click', () => {
  requireAllTaxonomy = !requireAllTaxonomy;
  updateTaxonomyLogicButton();
  renderGames();
});
updateTaxonomyLogicButton();

document.querySelector('.app-layout').addEventListener('click', event => {
  const option = event.target.closest('button[data-filter-value]');
  if (!option) return;
  const selected = !selectedTaxonomy.has(option.dataset.filterValue);
  if (selected) selectedTaxonomy.add(option.dataset.filterValue);
  else selectedTaxonomy.delete(option.dataset.filterValue);
  document.querySelectorAll('button[data-filter-value]').forEach(button => {
    const isSelected = selectedTaxonomy.has(button.dataset.filterValue);
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
  renderGames();
});

async function load() {
  try {
    const response = await fetch('/api/games');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    games = result.games;
    timeCeiling = Math.max(5, Math.ceil(Math.max(0, ...games.map(game => Number(game.maxTime) || Number(game.time) || 0)) / 5) * 5);
    const timeSlider = document.querySelector('#time-value-input');
    timeSlider.max = String(timeCeiling);
    timeValue = timeMode === 'maximum' ? timeCeiling : 0;
    timeSlider.value = String(timeValue);
    updateRangeValues();
    renderFilters();
    renderGames();
  } catch (error) { gameGrid.innerHTML = `<p class="message">Could not load collection.\n${escapeHTML(error.message)}</p>`; }
}
load();
