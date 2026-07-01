/* 刷题网页应用 — Vue 3 Composition API
 * 数据：window.EXAM_BANK（由 exam-bank.js 提供，离线可用）
 * 存储：localStorage（个人用量足够，简单可靠）
 */
const { createApp, ref, computed, watch, onMounted } = Vue;

// ---------- 本地存储封装 ----------
const LS = {
  get(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  },
};

const TYPE_LABEL = { single: '单选题', multiple: '多选题', judge: '判断题' };

createApp({
  setup() {
    const bank = window.EXAM_BANK;
    const subjects = bank.subjects;

    // 扁平化题目索引，附带科目/章节引用，便于筛选与统计
    const allQuestions = [];
    subjects.forEach(s => {
      s.questions.forEach(q => {
        let chapterId = null, chapterName = null;
        if (q.chapter) {
          const ch = (s.chapters || []).find(c => c.name === q.chapter);
          if (ch) { chapterId = ch.id; chapterName = ch.name; }
        }
        allQuestions.push({
          ...q, subjectId: s.id, subjectName: s.name, chapterId, chapterName,
        });
      });
    });

    // ---------- 视图与筛选状态 ----------
    const view = ref('practice'); // practice | wrongbook | favorites | records | stats
    const currentSubjectId = ref(subjects[0].id);
    const currentChapterId = ref('all');
    const currentType = ref('all');

    const currentSubject = computed(() => subjects.find(s => s.id === currentSubjectId.value) || subjects[0]);
    const hasChapters = computed(() => (currentSubject.value.chapters || []).length > 0);

    // ---------- 练习队列 ----------
    const queue = ref(null); // null=用筛选结果；数组=自定义（随机/错题重做等）
    const currentIndex = ref(0);

    const filteredQuestions = computed(() =>
      allQuestions.filter(q =>
        (currentSubjectId.value === 'all' || q.subjectId === currentSubjectId.value) &&
        (currentChapterId.value === 'all' || q.chapterId === currentChapterId.value) &&
        (currentType.value === 'all' || q.type === currentType.value)
      )
    );
    const currentQueue = computed(() => (queue.value ? queue.value : filteredQuestions.value));
    const currentQuestion = computed(() => currentQueue.value[currentIndex.value] || {});

    // ---------- 作答状态 ----------
    const sessionAnswers = ref(LS.get('sessionAnswers', {}));   // {qid: answer}
    const sessionSubmitted = ref(LS.get('sessionSubmitted', {})); // {qid: bool}
    const sessionPeeked = ref(LS.get('sessionPeeked', {}));       // {qid: bool} 是否"查看答案"过

    // ---------- 持久化数据 ----------
    const attempts = ref(LS.get('attempts', []));     // {qid,subjectId,type,selected,isCorrect,ts}
    const wrongIds = ref(LS.get('wrongIds', []));
    const favoriteIds = ref(LS.get('favoriteIds', []));
    const lastSession = ref(LS.get('lastSession', null));
    const showResumeBanner = ref(false);

    // ---------- 主题 ----------
    const theme = ref(LS.get('theme', 'auto'));

    // ---------- 随机抽题 ----------
    const randomCount = ref(10);

    // ---------- 判分 ----------
    function isCorrect(q, userAns) {
      if (userAns == null) return false;
      const correct = new Set(q.type === 'multiple' ? q.answer.split('') : [q.answer]);
      const user = new Set(Array.isArray(userAns) ? userAns : [userAns]);
      return correct.size === user.size && [...correct].every(c => user.has(c));
    }
    function correctKeys(q) {
      return q.type === 'multiple' ? q.answer.split('') : [q.answer];
    }

    // ---------- 选项交互 ----------
    function selectOption(key) {
      const q = currentQuestion.value;
      if (!q.id || sessionSubmitted.value[q.id]) return; // 提交后锁定
      if (q.type === 'multiple') {
        const arr = Array.isArray(sessionAnswers.value[q.id]) ? [...sessionAnswers.value[q.id]] : [];
        const i = arr.indexOf(key);
        if (i === -1) arr.push(key); else arr.splice(i, 1);
        sessionAnswers.value[q.id] = arr;
      } else {
        sessionAnswers.value[q.id] = key;
      }
      LS.set('sessionAnswers', sessionAnswers.value);
    }
    function isSelected(key) {
      const a = sessionAnswers.value[currentQuestion.value.id];
      if (a == null) return false;
      return Array.isArray(a) ? a.includes(key) : a === key;
    }
    const hasSelection = computed(() => {
      const a = sessionAnswers.value[currentQuestion.value.id];
      if (a == null) return false;
      return Array.isArray(a) ? a.length > 0 : true;
    });
    const isSubmitted = computed(() => !!sessionSubmitted.value[currentQuestion.value.id]);
    const isPeeked = computed(() => !!sessionPeeked.value[currentQuestion.value.id]);
    const isCurrentCorrect = computed(() => {
      const q = currentQuestion.value;
      return q.id ? isCorrect(q, sessionAnswers.value[q.id]) : false;
    });
    // 当前题正确选项字母数组（用于高亮与展示）
    const correctKeysDisplay = computed(() => {
      const q = currentQuestion.value;
      if (!q.id) return [];
      return correctKeys(q);
    });

    function submitAnswer() {
      const q = currentQuestion.value;
      if (!q.id || !hasSelection.value || sessionSubmitted.value[q.id]) return;
      const userAns = sessionAnswers.value[q.id];
      const correct = isCorrect(q, userAns);
      sessionSubmitted.value[q.id] = true;
      LS.set('sessionSubmitted', sessionSubmitted.value);
      attempts.value.push({
        qid: q.id, subjectId: q.subjectId, type: q.type,
        selected: userAns, isCorrect: correct, ts: Date.now(),
      });
      if (attempts.value.length > 3000) attempts.value = attempts.value.slice(-3000);
      LS.set('attempts', attempts.value);
      if (!correct && !wrongIds.value.includes(q.id)) {
        wrongIds.value.push(q.id);
        LS.set('wrongIds', wrongIds.value);
      }
      saveLastSession();
    }
    function showAnswer() {
      const q = currentQuestion.value;
      if (!q.id) return;
      const keys = correctKeys(q);
      sessionAnswers.value[q.id] = q.type === 'multiple' ? [...keys] : keys[0];
      sessionSubmitted.value[q.id] = true;
      sessionPeeked.value[q.id] = true;  // 标记为"查看答案"，不计入答题
      LS.set('sessionAnswers', sessionAnswers.value);
      LS.set('sessionSubmitted', sessionSubmitted.value);
      LS.set('sessionPeeked', sessionPeeked.value);
    }
    function resetAnswer() {
      const q = currentQuestion.value;
      if (!q.id) return;
      delete sessionAnswers.value[q.id];
      delete sessionSubmitted.value[q.id];
      delete sessionPeeked.value[q.id];
      LS.set('sessionAnswers', sessionAnswers.value);
      LS.set('sessionSubmitted', sessionSubmitted.value);
      LS.set('sessionPeeked', sessionPeeked.value);
    }

    // ---------- 导航 ----------
    function goToPage(i) {
      const n = currentQueue.value.length;
      if (i < 0) i = 0;
      if (i > n - 1) i = n - 1;
      currentIndex.value = i;
      view.value = 'practice';
      saveLastSession();
    }
    function next() { goToPage(currentIndex.value + 1); }
    function prev() { goToPage(currentIndex.value - 1); }

    // ---------- 筛选切换 ----------
    function setSubject(id) {
      currentSubjectId.value = id;
      currentChapterId.value = 'all';
      resetQueue();
    }
    function setChapter(id) { currentChapterId.value = id; resetQueue(); }
    function setType(t) { currentType.value = t; resetQueue(); }
    function resetQueue() {
      queue.value = null;
      currentIndex.value = 0;
      view.value = 'practice';
      saveLastSession();
    }

    // ---------- 收藏 ----------
    function isFavorite(qid) { return favoriteIds.value.includes(qid); }
    function toggleFavorite(qid) {
      const i = favoriteIds.value.indexOf(qid);
      if (i === -1) favoriteIds.value.push(qid);
      else favoriteIds.value.splice(i, 1);
      LS.set('favoriteIds', favoriteIds.value);
    }

    // ---------- 错题 / 收藏 列表 ----------
    const wrongQuestions = computed(() =>
      wrongIds.value.map(id => allQuestions.find(q => q.id === id)).filter(Boolean)
    );
    const favoriteQuestions = computed(() =>
      favoriteIds.value.map(id => allQuestions.find(q => q.id === id)).filter(Boolean)
    );

    function openInPractice(qid) {
      const q = allQuestions.find(x => x.id === qid);
      if (!q) return;
      currentSubjectId.value = q.subjectId;
      currentChapterId.value = 'all';
      currentType.value = 'all';
      queue.value = null;
      const idx = filteredQuestions.value.findIndex(x => x.id === qid);
      currentIndex.value = idx >= 0 ? idx : 0;
      view.value = 'practice';
      saveLastSession();
    }
    function startWrongRedo() {
      const list = wrongQuestions.value.slice();
      shuffle(list);
      if (!list.length) return;
      queue.value = list;
      currentIndex.value = 0;
      view.value = 'practice';
      saveLastSession();
    }
    function browseFavorites() {
      const list = favoriteQuestions.value.slice();
      if (!list.length) return;
      queue.value = list;
      currentIndex.value = 0;
      view.value = 'practice';
      saveLastSession();
    }
    function removeFromWrong(qid) {
      const i = wrongIds.value.indexOf(qid);
      if (i !== -1) { wrongIds.value.splice(i, 1); LS.set('wrongIds', wrongIds.value); }
    }

    // ---------- 随机抽题 ----------
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    function startRandom() {
      const pool = filteredQuestions.value.slice();
      if (!pool.length) return;
      shuffle(pool);
      const n = Math.min(Math.max(1, parseInt(randomCount.value) || 10), pool.length);
      queue.value = pool.slice(0, n);
      currentIndex.value = 0;
      view.value = 'practice';
      saveLastSession();
    }

    // ---------- 统计 ----------
    function scopeStats(questionIds) {
      const idset = new Set(questionIds);
      const rel = attempts.value.filter(a => idset.has(a.qid));
      const attempted = new Set(rel.map(a => a.qid));
      const correct = new Set(rel.filter(a => a.isCorrect).map(a => a.qid));
      const total = questionIds.length;
      const aN = attempted.size, cN = correct.size;
      return { total, attempted: aN, correct: cN, rate: aN ? Math.round(cN / aN * 100) : 0 };
    }
    const scopeIds = computed(() => filteredQuestions.value.map(q => q.id));
    const scopeStat = computed(() => scopeStats(scopeIds.value));

    // 统计视图：按科目 / 题型 / 章节
    const statsBySubject = computed(() =>
      subjects.map(s => ({ label: s.name, ...scopeStats(s.questions.map(q => q.id)) }))
    );
    const statsByType = computed(() => {
      const types = ['single', 'multiple', 'judge'];
      return types.map(t => ({
        label: TYPE_LABEL[t],
        ...scopeStats(allQuestions.filter(q => q.type === t).map(q => q.id)),
      }));
    });
    const statsByChapter = computed(() => {
      const subj = currentSubject.value;
      if (!(subj.chapters || []).length) return [];
      return subj.chapters.map(c => ({
        label: c.name,
        ...scopeStats(
          allQuestions.filter(q => q.subjectId === subj.id && q.chapterId === c.id).map(q => q.id)
        ),
      }));
    });

    // ---------- 做题记录 ----------
    const recentAttempts = computed(() =>
      attempts.value.slice().reverse().slice(0, 100)
    );
    function fmtTime(ts) {
      try { return new Date(ts).toLocaleString('zh-CN'); } catch (e) { return ''; }
    }
    function qBrief(qid) {
      const q = allQuestions.find(x => x.id === qid);
      return q ? `${q.subjectName} · ${TYPE_LABEL[q.type]} · ${q.stem.slice(0, 24)}…` : qid;
    }
    const overallStat = computed(() => {
      const total = attempts.value.length;
      const correct = attempts.value.filter(a => a.isCorrect).length;
      return { total, correct, rate: total ? Math.round(correct / total * 100) : 0 };
    });

    // ---------- 续做 ----------
    function saveLastSession() {
      lastSession.value = {
        subjectId: currentSubjectId.value,
        chapterId: currentChapterId.value,
        type: currentType.value,
        index: currentIndex.value,
        view: view.value,
        queue: queue.value ? queue.value.map(q => q.id) : null,
        ts: Date.now(),
      };
      LS.set('lastSession', lastSession.value);
    }
    function resumeLast() {
      const ls = lastSession.value;
      if (!ls) return;
      currentSubjectId.value = ls.subjectId;
      currentChapterId.value = ls.chapterId || 'all';
      currentType.value = ls.type || 'all';
      queue.value = null;
      const n = currentQueue.value.length;
      let idx = ls.index || 0;
      if (idx > n - 1) idx = n - 1;
      currentIndex.value = idx;
      view.value = 'practice';
      showResumeBanner.value = false;
    }
    function dismissResume() { showResumeBanner.value = false; }
    const resumeDesc = computed(() => {
      const ls = lastSession.value;
      if (!ls) return '';
      const subj = subjects.find(s => s.id === ls.subjectId);
      return `${subj ? subj.name : ''} 第 ${(ls.index || 0) + 1} 题`;
    });

    // ---------- 主题 ----------
    function applyTheme() {
      const eff = theme.value === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme.value;
      document.documentElement.dataset.theme = eff;
    }
    function setTheme(t) { theme.value = t; LS.set('theme', t); applyTheme(); }
    function cycleTheme() {
      const order = ['light', 'dark', 'auto'];
      setTheme(order[(order.indexOf(theme.value) + 1) % 3]);
    }
    const themeIcon = computed(() => ({ light: '☀️', dark: '🌙', auto: '🖥️' }[theme.value] || '🖥️'));
    const themeLabel = computed(() => ({ light: '浅色', dark: '深色', auto: '跟随系统' }[theme.value] || ''));

    // ---------- 导入 / 导出 ----------
    function exportData() {
      const payload = {
        version: bank.version,
        exportedAt: new Date().toISOString(),
        attempts: attempts.value,
        wrongIds: wrongIds.value,
        favoriteIds: favoriteIds.value,
        lastSession: lastSession.value,
        sessionAnswers: sessionAnswers.value,
        sessionSubmitted: sessionSubmitted.value,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      a.href = url; a.download = `exam-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
    function importData(ev) {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!confirm('导入将覆盖当前的进度、错题、收藏与记录，确定继续？')) { ev.target.value = ''; return; }
          if (Array.isArray(data.attempts)) { attempts.value = data.attempts; LS.set('attempts', attempts.value); }
          if (Array.isArray(data.wrongIds)) { wrongIds.value = data.wrongIds; LS.set('wrongIds', wrongIds.value); }
          if (Array.isArray(data.favoriteIds)) { favoriteIds.value = data.favoriteIds; LS.set('favoriteIds', favoriteIds.value); }
          if (data.lastSession) { lastSession.value = data.lastSession; LS.set('lastSession', lastSession.value); }
          if (data.sessionAnswers) { sessionAnswers.value = data.sessionAnswers; LS.set('sessionAnswers', sessionAnswers.value); }
          if (data.sessionSubmitted) { sessionSubmitted.value = data.sessionSubmitted; LS.set('sessionSubmitted', sessionSubmitted.value); }
          alert('导入成功');
          showResumeBanner.value = false;
          view.value = 'practice';
        } catch (e) {
          alert('导入失败：文件格式不正确');
        }
        ev.target.value = '';
      };
      reader.readAsText(file);
    }

    // ---------- 重置全部 ----------
    function resetAll() {
      if (!confirm('将清空全部进度、错题、收藏与记录，且不可恢复，确定？')) return;
      attempts.value = []; wrongIds.value = []; favoriteIds.value = [];
      sessionAnswers.value = {}; sessionSubmitted.value = {}; lastSession.value = null;
      LS.set('attempts', []); LS.set('wrongIds', []);
      LS.set('favoriteIds', []); LS.set('sessionAnswers', {});
      LS.set('sessionSubmitted', {}); LS.set('lastSession', null);
      queue.value = null; currentIndex.value = 0; showResumeBanner.value = false;
    }

    // ---------- 生命周期 ----------
    watch(currentIndex, () => { if (view.value === 'practice') saveLastSession(); });

    onMounted(() => {
      applyTheme();
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (theme.value === 'auto') applyTheme();
      });
      const ls = lastSession.value;
      if (ls && ls.subjectId) {
        // 恢复筛选以便续做可用，但不自动跳转，仅提示
        currentSubjectId.value = ls.subjectId;
        currentChapterId.value = ls.chapterId || 'all';
        currentType.value = ls.type || 'all';
        showResumeBanner.value = true;
      }
    });

    return {
      // 数据
      subjects, allQuestions, TYPE_LABEL,
      // 视图/筛选
      view, currentSubjectId, currentChapterId, currentType,
      currentSubject, hasChapters, filteredQuestions, currentQueue, currentQuestion, currentIndex,
      queue, lastSession,
      // 作答
      sessionAnswers, sessionSubmitted, selectOption, isSelected, hasSelection,
      isSubmitted, isPeeked, isCurrentCorrect, correctKeysDisplay, submitAnswer, showAnswer, resetAnswer,
      // 导航
      next, prev, goToPage,
      // 筛选
      setSubject, setChapter, setType, resetQueue,
      // 收藏
      isFavorite, toggleFavorite,
      // 错题/收藏列表
      wrongQuestions, favoriteQuestions, openInPractice, startWrongRedo, browseFavorites, removeFromWrong,
      // 随机
      randomCount, startRandom,
      // 统计
      scopeStat, statsBySubject, statsByType, statsByChapter,
      // 记录
      recentAttempts, overallStat, fmtTime, qBrief,
      // 续做
      showResumeBanner, resumeLast, dismissResume, resumeDesc,
      // 主题
      theme, setTheme, cycleTheme, themeIcon, themeLabel,
      // 导入导出
      exportData, importData, resetAll,
    };
  },
}).mount('#app');
