export function shouldProcessAppMention(): boolean {
	// app_mention is ignored; message events already include channel mentions.
	return false;
}

export function shouldProcessMessageEvent(isDM: boolean, _isBotMention: boolean): boolean {
	// Process all non-DM channel messages, including @mentions.
	return !isDM;
}
