import { EventEmitter } from "node:events";

type HubHandler = (event: string, data: unknown) => void;

class ImapEventHub {
	private readonly emitter = new EventEmitter();

	constructor() {
		this.emitter.setMaxListeners(0);
	}

	subscribe(userEmail: string, handler: HubHandler): () => void {
		const channel = userEmail.toLowerCase();
		this.emitter.on(channel, handler);
		return () => {
			this.emitter.off(channel, handler);
		};
	}

	publish(userEmail: string, event: string, data: unknown): void {
		this.emitter.emit(userEmail.toLowerCase(), event, data);
	}
}

export const imapEventHub = new ImapEventHub();
