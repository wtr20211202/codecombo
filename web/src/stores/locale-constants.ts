// localStorage key：保存用户选定的 locale
// 独立文件避免 i18n/index.ts 与 stores/locale.ts 互相 import 时的循环依赖
export const LOCALE_STORAGE_KEY = 'locale-settings'
