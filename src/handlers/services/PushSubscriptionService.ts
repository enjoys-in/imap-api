import { PushSubscriptionEntity } from "@/factory/entities";
import { InjectRepository } from "@/factory/typeorm";
import { In } from "typeorm";
import type { PushAudience } from "./pushConfig";

export interface PushSubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
	audience: PushAudience;
	includePreview: boolean;
	userAgent: string | null;
}

export class PushSubscriptionService {
	private get repo() {
		return InjectRepository(PushSubscriptionEntity);
	}

	async save(
		connectionId: number,
		input: PushSubscriptionInput,
	): Promise<PushSubscriptionEntity> {
		const existing = await this.repo.findOne({
			where: { endpoint: input.endpoint },
		});
		const row =
			existing ??
			this.repo.create({ endpoint: input.endpoint, last_notified_at: null });
		row.connection_id = connectionId;
		row.p256dh = input.p256dh;
		row.auth = input.auth;
		row.audience = input.audience;
		row.include_preview = input.includePreview;
		row.user_agent = input.userAgent;
		return this.repo.save(row);
	}

	async removeEndpoint(
		endpoint: string,
		connectionId?: number,
	): Promise<number> {
		const result = await this.repo.delete(
			connectionId === undefined
				? { endpoint }
				: { endpoint, connection_id: connectionId },
		);
		return result.affected ?? 0;
	}

	async removeId(id: number): Promise<void> {
		await this.repo.delete({ id });
	}

	async forConnection(connectionId: number): Promise<PushSubscriptionEntity[]> {
		return this.repo.find({
			where: { connection_id: connectionId },
			order: { id: "ASC" },
		});
	}

	async connectionIds(): Promise<number[]> {
		const rows = await this.repo
			.createQueryBuilder("s")
			.select("DISTINCT s.connection_id", "connection_id")
			.getRawMany<{ connection_id: number }>();
		return rows.map((row) => Number(row.connection_id));
	}

	async markNotified(ids: number[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		await this.repo.update({ id: In(ids) }, { last_notified_at: new Date() });
	}
}

export const pushSubscriptionService = new PushSubscriptionService();
