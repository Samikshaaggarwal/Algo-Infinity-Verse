let tQuiz = null;
let currentFilter = 'all';
let currentSearch = '';

// ============================================
// HASH CHANGE ROUTER
// ============================================
window.addEventListener('hashchange', () => {
  const currentHash = window.location.hash || '#home';
  if (currentHash === '#home' || currentHash === '') {
    document.querySelectorAll('*').forEach(element => {
      if (element.id?.toLowerCase().includes('quiz') || element.className?.toString().toLowerCase().includes('quiz') || element.id?.toLowerCase().includes('assistant')) element.style.display = 'none';
      else if (element.classList.contains('hidden') && element.id !== 'loading-screen') { element.classList.remove('hidden'); element.style.display = ''; }
    });
    if (typeof tQuiz !== 'undefined' && tQuiz !== null) tQuiz = null;
  }
  
  const path = window.location.pathname;
  if (path.includes('/pages/learning/') || path.includes('/pages/visualizers/') || path.includes('/pages/resources/')) {
    const script = document.createElement('script');
    script.src = '/scripts/report-issue.js';
    document.body.appendChild(script);
  }
});

if (window.navManager) {
  window.navManager.subscribe((state) => {
    if (state.tab === 'practice') {
      currentFilter = state.filter || 'all';
      currentSearch = state.search || '';
      
      const searchInput = document.getElementById('searchInput');
      const clearBtn = document.getElementById('clearSearchBtn');
      if (searchInput) searchInput.value = currentSearch;
      if (clearBtn) {
          if (currentSearch.length > 0) clearBtn.classList.add('visible');
          else clearBtn.classList.remove('visible');
      }
      
      const filterButtons = document.querySelectorAll('.filter-btn');
      filterButtons.forEach((b) => b.classList.remove('active'));
      const activeBtn = Array.from(filterButtons).find(b => b.dataset.filter === currentFilter);
      if (activeBtn) activeBtn.classList.add('active');
      
      if (typeof renderProblems === 'function') renderProblems();
    }
    
    const modal = document.getElementById('quizEditorModal');
    if (state.problem) {
      if (!modal || !modal.classList.contains('active')) {
        const problem = typeof practiceProblems !== 'undefined' ? practiceProblems.find(p => p.id == state.problem) : null;
        if (problem && typeof openQuizEditor === 'function') openQuizEditor(problem, true);
      }
    } else {
      if (modal && modal.classList.contains('active')) {
        if (typeof closeQuizEditor === 'function') closeQuizEditor(true);
      }
    }
  });

  if (navManager.state.problem && typeof practiceProblems !== 'undefined') {
    const problem = practiceProblems.find(p => p.id == navManager.state.problem);
    if (problem && typeof openQuizEditor === 'function') openQuizEditor(problem, true);
  }
}
