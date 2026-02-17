export function shouldProcessAppMention(): boolean {
	// app_mention is ignored; message events already include channel mentions.
	return false;
}

export function shouldProcessMessageEvent(_isDM: boolean, _isBotMention: boolean): boolean {
	// Process both channel messages and DMs.
	return true;
}
