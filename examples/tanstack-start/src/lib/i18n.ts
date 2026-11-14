// Minimal bilingual support for the reference UI. No i18n framework: a tiny
// localStorage-backed store + useSyncExternalStore. The English values must
// match the historical UI strings verbatim (the e2e suite asserts them), and
// English stays the default language.
import { useSyncExternalStore } from "react";

export type Locale = "en" | "zh";
export type DictKey = keyof typeof en;

const STORAGE_KEY = "helpdesk-locale";

const en = {
  // Header (root route)
  "root.signedInAs": "Signed in as",
  "root.nobody": "(nobody)",
  "root.demoUser": "Demo user",
  "root.language": "Language",
  "root.en": "EN",
  "root.zh": "中文",
  // Inbox views (index route)
  "views.open": "Open",
  "views.mine": "Mine",
  "views.unassigned": "Unassigned",
  "views.pending": "Waiting on customer",
  "views.closed": "Solved / closed",
  "views.all": "All",
  "inbox.viewsNav": "Views",
  "inbox.pickUser": "Choose a demo user (top right) to see their tickets.",
  "inbox.searchPlaceholder": "Search subject or ref",
  "inbox.search": "Search",
  "inbox.loadError": "Couldn't load tickets",
  "col.ref": "Ref",
  "col.subject": "Subject",
  "col.status": "Status",
  "col.priority": "Priority",
  "col.category": "Category",
  "col.assignee": "Assignee",
  "col.updated": "Updated",
  "inbox.loading": "Loading…",
  "inbox.empty": "No tickets here.",
  "inbox.loadMore": "Load more",
  // Ticket detail
  "ticket.loading": "Loading…",
  "ticket.back": "← Inbox",
  "ticket.from": "From",
  "ticket.category": "category",
  "ticket.fieldset": "Ticket",
  "ticket.status": "Status",
  "ticket.priority": "Priority",
  "ticket.assignee": "Assignee",
  "ticket.unassigned": "(unassigned)",
  "ticket.assignToMe": "Assign to me",
  "ticket.notFound": "No such ticket (or not in your company).",
  "ticket.conflict": "Someone else changed this ticket; reloaded.",
  "ticket.conversation": "Conversation",
  "ticket.history": "History",
  // Status / priority display names (English values = the raw enum values)
  "status.new": "new",
  "status.open": "open",
  "status.pending": "pending",
  "status.on_hold": "on_hold",
  "status.solved": "solved",
  "status.closed": "closed",
  "priority.low": "low",
  "priority.normal": "normal",
  "priority.high": "high",
  "priority.urgent": "urgent",
  // Messages
  "msg.customer": "Customer",
  "msg.ack": "Auto-acknowledgement",
  "msg.agent_reply": "Reply",
  "msg.note": "Internal note",
  "msg.showFull": "Show full message",
  "msg.attachment": "attachment",
  "msg.type": "Message type",
  "msg.replyCustomer": "Reply to customer (emailed)",
  "msg.internalNote": "Internal note",
  "msg.replyAria": "Reply",
  "msg.noteAria": "Note",
  "msg.thenSetStatus": "Then set status",
  "msg.sending": "Sending…",
  "msg.sendReply": "Send reply",
  "msg.addNote": "Add note",
} as const;

const zh: Record<DictKey, string> = {
  "root.signedInAs": "登入身分",
  "root.nobody": "(未選擇)",
  "root.demoUser": "示範使用者",
  "root.language": "語言",
  "root.en": "EN",
  "root.zh": "中文",
  "views.open": "進行中",
  "views.mine": "我的",
  "views.unassigned": "未指派",
  "views.pending": "等待客戶回覆",
  "views.closed": "已解決/結案",
  "views.all": "全部",
  "inbox.viewsNav": "檢視",
  "inbox.pickUser": "請在右上角選擇示範使用者,即可查看其工單。",
  "inbox.searchPlaceholder": "搜尋主旨或工單編號",
  "inbox.search": "搜尋",
  "inbox.loadError": "無法載入工單",
  "col.ref": "編號",
  "col.subject": "主旨",
  "col.status": "狀態",
  "col.priority": "優先順序",
  "col.category": "分類",
  "col.assignee": "負責人",
  "col.updated": "更新時間",
  "inbox.loading": "載入中…",
  "inbox.empty": "目前沒有工單。",
  "inbox.loadMore": "載入更多",
  "ticket.loading": "載入中…",
  "ticket.back": "← 收件匣",
  "ticket.from": "來自",
  "ticket.category": "分類",
  "ticket.fieldset": "工單",
  "ticket.status": "狀態",
  "ticket.priority": "優先順序",
  "ticket.assignee": "負責人",
  "ticket.unassigned": "(未指派)",
  "ticket.assignToMe": "指派給我",
  "ticket.notFound": "查無此工單(或不在您的公司範圍內)。",
  "ticket.conflict": "此工單已被他人修改,已重新載入。",
  "ticket.conversation": "對話紀錄",
  "ticket.history": "歷程",
  "status.new": "新建",
  "status.open": "處理中",
  "status.pending": "等待客戶",
  "status.on_hold": "暫緩",
  "status.solved": "已解決",
  "status.closed": "已結案",
  "priority.low": "低",
  "priority.normal": "普通",
  "priority.high": "高",
  "priority.urgent": "緊急",
  "msg.customer": "客戶",
  "msg.ack": "自動確認信",
  "msg.agent_reply": "回覆",
  "msg.note": "內部備註",
  "msg.showFull": "顯示完整訊息",
  "msg.attachment": "附件",
  "msg.type": "訊息類型",
  "msg.replyCustomer": "回覆客戶(將寄送電子郵件)",
  "msg.internalNote": "內部備註",
  "msg.replyAria": "回覆",
  "msg.noteAria": "備註",
  "msg.thenSetStatus": "回覆後將狀態設為",
  "msg.sending": "傳送中…",
  "msg.sendReply": "寄出回覆",
  "msg.addNote": "新增備註",
};

function detectLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
    return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en"; // no window (SSR) or storage blocked
  }
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

/** Switch the UI language and remember the choice across visits. */
export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: keep the choice for this page view only */
  }
  for (const l of listeners) l();
}

/** Current language as a hook; re-renders every mounted useT() on switch. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => "en" as Locale, // SSR / hydration snapshot; the client re-renders with its own value
  );
}

/** Translate a dictionary key in the current language. */
export function useT(): (key: DictKey) => string {
  const locale = useLocale();
  const dict = locale === "zh" ? zh : en;
  return (key) => dict[key] ?? en[key];
}