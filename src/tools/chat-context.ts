// Chat ID state shared across tools (previously in run-agent.ts)
let currentChatId: string = "";

export function setCurrentChatId(chatId: string): void {
  currentChatId = chatId;
}

export function getCurrentChatId(): string {
  return currentChatId;
}
