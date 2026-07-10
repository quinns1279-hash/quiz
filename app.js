/* 刷题网页应用 — Vue 3 Composition API
 * 数据：按科目拆分，subjects/*.js 各科目题库 + subjects.config.js 注册表（离线可用）
 * 存储：localStorage（个人用量足够，简单可靠）
 * 加载：用户选择科目时按需加载对应题库文件，已加载的缓存复用
 */
const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

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

const TYPE_LABEL = { single: '单选题', multiple: '多选题', judge: '判断题', term: '名词解释', essay: '问答题' };
// 主观题（无客观答案，输入框作答，点查看答案显示标准答案，不判分）
const SUBJECTIVE_TYPES = ['term', 'essay'];
const isSubjectiveType = t => SUBJECTIVE_TYPES.includes(t);

// ---------- 科目题库按需加载（模块级缓存，全局共享）----------
const bankCache = {}; // {科目id: 题库对象}，已加载的科目题库
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}
// 加载某科目题库（已加载则直接返回缓存），返回该科目题库对象
async function loadSubject(cfg) {
  if (bankCache[cfg.id]) return bankCache[cfg.id];
  window.SUBJECT_BANK = window.SUBJECT_BANK || {};
  if (!window.SUBJECT_BANK[cfg.id]) {
    await loadScript(cfg.file);
  }
  bankCache[cfg.id] = window.SUBJECT_BANK[cfg.id];
  return bankCache[cfg.id];
}

createApp({
  setup() {
    // 注册表（轻量元数据，启动即可用，不含题目）
    const subjectConfigs = (window.SUBJECTS_CONFIG || []).filter(s => s.enabled);
    // 兼容旧代码：subjects 提供与注册表等价的元数据（含 chapters 预览，从题库读取）
    // 用 reactive 包裹：科目加载后给 chapters 赋值能触发 hasChapters 等依赖更新，章节筛选才会显示
    const subjects = reactive(subjectConfigs.map(c => ({ id: c.id, name: c.name, chapters: [], _file: c.file })));

    // 已加载科目的标记（响应式，加载完成后触发 computed 重算）
    const loadedSubjectIds = ref([]);

    // 当前选中科目，默认第一个（首科目在 onMounted 中异步加载）
    const currentSubjectId = ref(subjects[0].id);

    // 把已加载科目的 chapters 同步到 subjects（供 hasChapters 判断）
    function syncLoadedMeta() {
      loadedSubjectIds.value.forEach(id => {
        const idx = subjects.findIndex(s => s.id === id);
        if (idx >= 0 && bankCache[id]) subjects[idx].chapters = bankCache[id].chapters || [];
      });
    }

    // 扁平化"已加载科目"的题目（附带科目/章节引用）
    const allQuestions = computed(() => {
      const list = [];
      loadedSubjectIds.value.forEach(id => {
        const s = bankCache[id];
        if (!s) return;
        s.questions.forEach(q => {
          let chapterId = null, chapterName = null;
          if (q.chapter) {
            const ch = (s.chapters || []).find(c => c.name === q.chapter);
            if (ch) { chapterId = ch.id; chapterName = ch.name; }
          }
          list.push({ ...q, subjectId: s.id, subjectName: s.name, chapterId, chapterName });
        });
      });
      return list;
    });

    // ---------- 视图与筛选状态 ----------
    const view = ref('practice'); // practice | wrongbook | favorites | records | stats
    const currentChapterId = ref('all');
    const currentType = ref('all');

    const currentSubject = computed(() => subjects.find(s => s.id === currentSubjectId.value) || subjects[0]);
    const hasChapters = computed(() => (currentSubject.value.chapters || []).length > 0);

    // ---------- 练习队列 ----------
    const queue = ref(null); // null=用筛选结果；数组=自定义（随机/错题重做等）
    const currentIndex = ref(0);

    const filteredQuestions = computed(() =>
      allQuestions.value.filter(q =>
        (currentSubjectId.value === 'all' || q.subjectId === currentSubjectId.value) &&
        (currentChapterId.value === 'all' || q.chapterId === currentChapterId.value) &&
        (currentType.value === 'all' || q.type === currentType.value)
      )
    );
    const currentQueue = computed(() => (queue.value ? queue.value : filteredQuestions.value));
    const currentQuestion = computed(() => currentQueue.value[currentIndex.value] || {});

    // ---------- 题号网格（需求1）----------
    const showGrid = ref(false);
    // 题目作答状态：客观题看 attempts 最近记录，主观题已查看=correct
    function questionStatus(qid, type) {
      if (isSubjectiveType(type)) {
        return sessionSubmitted.value[qid] ? 'correct' : 'unset';
      }
      const rec = [...attempts.value].reverse().find(a => a.qid === qid);
      if (!rec) return 'unset';
      return rec.isCorrect ? 'correct' : 'wrong';
    }
    const questionGrid = computed(() =>
      currentQueue.value.map((q, idx) => ({
        idx, qid: q.id, num: idx + 1,
        status: questionStatus(q.id, q.type),
        isCurrent: idx === currentIndex.value
      }))
    );
    const gridStats = computed(() => {
      let correct = 0, wrong = 0;
      questionGrid.value.forEach(g => {
        if (g.status === 'correct') correct++;
        else if (g.status === 'wrong') wrong++;
      });
      return { total: questionGrid.value.length, correct, wrong, done: correct + wrong };
    });

    // ---------- 统一列表来源（需求2：错题本/收藏复用筛选）----------
    const listMode = ref('all');  // 'all' | 'wrong' | 'favorite'
    const listQuestions = computed(() => {
      const base = filteredQuestions.value;
      if (listMode.value === 'wrong') {
        const wid = new Set(wrongIds.value);
        return base.filter(q => wid.has(q.id));
      }
      if (listMode.value === 'favorite') {
        const fid = new Set(favoriteIds.value);
        return base.filter(q => fid.has(q.id));
      }
      return base;
    });

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
    // 主观题输入框内容（独立 ref，避免污染客观题的 sessionAnswers 逻辑）
    const subjectiveInput = ref('');

    const hasSelection = computed(() => {
      const q = currentQuestion.value;
      // 主观题：判断输入框是否有内容
      if (isSubjectiveType(q.type)) return subjectiveInput.value.trim().length > 0;
      const a = sessionAnswers.value[q.id];
      if (a == null) return false;
      return Array.isArray(a) ? a.length > 0 : true;
    });
    const isSubmitted = computed(() => !!sessionSubmitted.value[currentQuestion.value.id]);
    const isPeeked = computed(() => !!sessionPeeked.value[currentQuestion.value.id]);
    const isSubjectiveCurrent = computed(() => isSubjectiveType(currentQuestion.value.type));
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
      if (!q.id || sessionSubmitted.value[q.id]) return;
      // 主观题（名词解释/问答）：提交=标记已查看，不判分、不进统计/错题本
      if (isSubjectiveType(q.type)) {
        // 保留用户输入的答案文本到 sessionAnswers
        if (!sessionAnswers.value[q.id]) sessionAnswers.value[q.id] = subjectiveInput.value;
        sessionSubmitted.value[q.id] = true;
        sessionPeeked.value[q.id] = true;  // 主观题统一按"已查看答案"标记
        LS.set('sessionAnswers', sessionAnswers.value);
        LS.set('sessionSubmitted', sessionSubmitted.value);
        LS.set('sessionPeeked', sessionPeeked.value);
        saveLastSession();
        nextTick(() => {
          const resultEl = document.querySelector('.result');
          if (resultEl) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return;
      }
      if (!hasSelection.value) return;
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
      if (correct) {
        // 答对：从错题本移除（如果存在）
        const idx = wrongIds.value.indexOf(q.id);
        if (idx !== -1) {
          wrongIds.value.splice(idx, 1);
          LS.set('wrongIds', wrongIds.value);
        }
      } else {
        // 答错：加入错题本（如果不存在）
        if (!wrongIds.value.includes(q.id)) {
          wrongIds.value.push(q.id);
          LS.set('wrongIds', wrongIds.value);
        }
      }
      saveLastSession();
      // 提交后自动滚动到解析区（PC 端体验优化）
      nextTick(() => {
        const resultEl = document.querySelector('.result');
        if (resultEl) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    // 主观题标准答案展示文本
    const subjectiveAnswer = computed(() => {
      const q = currentQuestion.value;
      return isSubjectiveType(q.type) ? (q.answer || '暂无标准答案') : '';
    });
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
      subjectiveInput.value = '';
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

    // 切题时同步主观题输入框：加载已保存的作答，或清空
    watch(currentQuestion, (q) => {
      if (q.id && isSubjectiveType(q.type)) {
        const saved = sessionAnswers.value[q.id];
        subjectiveInput.value = typeof saved === 'string' ? saved : '';
      } else {
        subjectiveInput.value = '';
      }
      // 网格展开时，当前题滚动到可视区
      if (showGrid.value) {
        nextTick(() => {
          const cell = document.querySelector('.q-grid-cell.active');
          if (cell) cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
    }, { immediate: true });

    // ---------- 筛选切换 ----------
    // 确保某科目已加载（未加载则按需加载，加载后同步元数据并刷新 loadedSubjectIds）
    async function ensureSubjectLoaded(id) {
      if (loadedSubjectIds.value.includes(id)) return;
      const cfg = subjectConfigs.find(c => c.id === id);
      if (!cfg) return;
      await loadSubject(cfg);
      const idx = subjects.findIndex(s => s.id === id);
      if (idx >= 0 && bankCache[id]) subjects[idx].chapters = bankCache[id].chapters || [];
      loadedSubjectIds.value = [...loadedSubjectIds.value, id];
    }

    async function setSubject(id) {
      await ensureSubjectLoaded(id);
      currentSubjectId.value = id;
      currentChapterId.value = 'all';
      resetQueue();
    }
    function setChapter(id) { currentChapterId.value = id; resetQueue(); }
    function setType(t) { currentType.value = t; resetQueue(); }
    function resetQueue() {
      queue.value = null;
      currentIndex.value = 0;
      // 不改 view：筛选切换时应停留在当前视图（如错题本），避免跳回练习页
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

    // 题目id → 科目id 映射（用于错题/收藏定位未加载科目的题目）
    // 优先从 attempts 历史推断，回退从题目id前缀推断
    function qidToSubjectId(qid) {
      const a = attempts.value.find(x => x.qid === qid);
      if (a) return a.subjectId;
      // 回退：用题目id第一段(到第一个-)匹配注册表科目
      const prefix = qid.split('-')[0];
      const cfg = subjectConfigs.find(c => c.id === prefix);
      return cfg ? cfg.id : null;
    }

    // 进入错题本/收藏视图时预加载所有相关科目（确保列表完整）
    async function ensureRelatedSubjectsLoaded(qids) {
      const ids = new Set(qids.map(qidToSubjectId).filter(Boolean));
      await Promise.all([...ids].map(id => ensureSubjectLoaded(id)));
    }

    // ---------- 错题 / 收藏 列表（展示用 listQuestions，按 listMode 收窄）----------
    const wrongQuestions = computed(() =>
      wrongIds.value.map(id => allQuestions.value.find(q => q.id === id)).filter(Boolean)
    );
    const favoriteQuestions = computed(() =>
      favoriteIds.value.map(id => allQuestions.value.find(q => q.id === id)).filter(Boolean)
    );

    async function openInPractice(qid) {
      const sid = qidToSubjectId(qid);
      if (sid) await ensureSubjectLoaded(sid);
      const q = allQuestions.value.find(x => x.id === qid);
      if (!q) return;
      // 保留当前章节/题型筛选（不再强制 'all'），仅确保科目对齐该题所属科目
      currentSubjectId.value = q.subjectId;
      queue.value = null;
      listMode.value = 'all';            // 回到正常列表来源
      // 索引基于 currentQueue（随筛选响应式更新），避免子集/全集错位
      await nextTick();
      const idx = currentQueue.value.findIndex(x => x.id === qid);
      currentIndex.value = idx >= 0 ? idx : 0;
      view.value = 'practice';
      saveLastSession();
    }
    function startWrongRedo() {
      // 使用当前筛选的错题列表（listMode='wrong' 下的 listQuestions）
      const list = listQuestions.value.slice();
      shuffle(list);
      if (!list.length) return;
      // 清空当前筛选错题范围的答题状态
      list.forEach(q => {
        delete sessionAnswers.value[q.id];
        delete sessionSubmitted.value[q.id];
        delete sessionPeeked.value[q.id];
      });
      LS.set('sessionAnswers', sessionAnswers.value);
      LS.set('sessionSubmitted', sessionSubmitted.value);
      LS.set('sessionPeeked', sessionPeeked.value);
      queue.value = list;
      currentIndex.value = 0;
      view.value = 'practice';
      saveLastSession();
    }
    // 返回正常列表：清队列、listMode 归 all，筛选条件保留（继承错题本里的设置）
    function backToPractice() {
      queue.value = null;
      listMode.value = 'all';
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

    // 批量重刷当前筛选范围：清空答题状态，错题本不清
    function resetCurrentFilter() {
      const ids = filteredQuestions.value.map(q => q.id);
      if (!ids.length) return;
      ids.forEach(qid => {
        delete sessionAnswers.value[qid];
        delete sessionSubmitted.value[qid];
        delete sessionPeeked.value[qid];
      });
      LS.set('sessionAnswers', sessionAnswers.value);
      LS.set('sessionSubmitted', sessionSubmitted.value);
      LS.set('sessionPeeked', sessionPeeked.value);
      // 清空队列，回到正常列表
      queue.value = null;
      currentIndex.value = 0;
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

    // 进入统计视图时加载全部启用科目（保证按科目/题型统计完整）
    async function loadAllSubjects() {
      await Promise.all(subjectConfigs.map(c => ensureSubjectLoaded(c.id)));
    }

    // 统计视图：按科目 / 题型 / 章节（仅统计已加载科目）
    const statsBySubject = computed(() =>
      loadedSubjectIds.value.map(id => {
        const s = bankCache[id];
        const meta = subjects.find(m => m.id === id);
        return { label: (meta && meta.name) || id, ...scopeStats(s.questions.map(q => q.id)) };
      })
    );
    const statsByType = computed(() => {
      const types = ['single', 'multiple', 'judge'];
      return types.map(t => ({
        label: TYPE_LABEL[t],
        ...scopeStats(allQuestions.value.filter(q => q.type === t).map(q => q.id)),
      }));
    });
    const statsByChapter = computed(() => {
      const subj = currentSubject.value;
      if (!(subj.chapters || []).length) return [];
      return subj.chapters.map(c => ({
        label: c.name,
        ...scopeStats(
          allQuestions.value.filter(q => q.subjectId === subj.id && q.chapterId === c.id).map(q => q.id)
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
      const q = allQuestions.value.find(x => x.id === qid);
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
    async function resumeLast() {
      const ls = lastSession.value;
      if (!ls) return;
      await ensureSubjectLoaded(ls.subjectId);
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

    onMounted(async () => {
      applyTheme();
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (theme.value === 'auto') applyTheme();
      });
      const ls = lastSession.value;
      if (ls && ls.subjectId) {
        // 仅恢复科目并提示，不自动恢复章节/题型筛选，避免页面打开后题数被静默缩减；
        // 用户点"继续"时由 resumeLast() 跳转到上次的章节与位置。
        await ensureSubjectLoaded(ls.subjectId);
        currentSubjectId.value = ls.subjectId;
        showResumeBanner.value = true;
      } else {
        // 无续做：加载首科目，保证练习页可用
        await ensureSubjectLoaded(subjects[0].id);
      }
    });

    // 切换视图时按需预加载相关科目
    watch(view, async (v) => {
      if (v === 'wrongbook') { listMode.value = 'wrong'; await ensureRelatedSubjectsLoaded(wrongIds.value); }
      else if (v === 'favorites') { listMode.value = 'favorite'; await ensureRelatedSubjectsLoaded(favoriteIds.value); }
      else if (v === 'stats') await loadAllSubjects();
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
      isSubjectiveCurrent, subjectiveInput, subjectiveAnswer,
      // 导航
      next, prev, goToPage,
      // 筛选
      setSubject, setChapter, setType, resetQueue, resetCurrentFilter,
      // 收藏
      isFavorite, toggleFavorite,
      // 错题/收藏列表
      wrongQuestions, favoriteQuestions, openInPractice, startWrongRedo, browseFavorites, removeFromWrong,
      backToPractice, listMode, listQuestions, showGrid, questionGrid, gridStats,
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
