// 科目注册表：声明启用的科目（增删科目只改这里）
// 章节是否展示由各 subjects/xxx.js 内的 chapters 字段决定
window.SUBJECTS_CONFIG = [
  {
    "id": "sixiu",
    "name": "教育思修",
    "file": "subjects/sixiu.js",
    "enabled": true,
    "description": ""
  },
  {
    "id": "meiyi",
    "name": "美伊冲突",
    "file": "subjects/meiyi.js",
    "enabled": true,
    "description": ""
  },
  {
    "id": "yingyongwen",
    "name": "应用文写作",
    "file": "subjects/yingyongwen.js",
    "enabled": true,
    "description": ""
  },
  {
    "id": "english",
    "name": "英语",
    "file": "subjects/english.js",
    "enabled": true,
    "description": ""
  },
  {
    "id": "economics",
    "name": "经济学",
    "file": "subjects/economics.js",
    "enabled": true,
    "description": "西方微观经济学"
  }
];
