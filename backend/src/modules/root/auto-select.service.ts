// Remnawave Subscription Page - AGPL-3.0-only
// Modifications: Auto-select server scoring by users, ping, and load

import net from 'node:net';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { AxiosService } from '@common/axios/axios.service';

interface NodeStats {
    nodeUuid: string;
    address: string;
    usersOnline: number;
    loadAvg: number[];
    memoryUsed: number;
    memoryTotal: number;
}

interface HostInfo {
    address: string;
    remark: string;
    port: number;
    nodeUuids: string[];
}

interface ScoredServer {
    link: string;
    originalName: string;
    hostname: string;
    score: number;
    users: number;
    ping: number;
    load: number;
}

const CACHE_TTL_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

@Injectable()
export class AutoSelectService implements OnModuleInit {
    private readonly logger = new Logger(AutoSelectService.name);

    private nodeStatsCache: NodeStats[] = [];
    private hostCache: HostInfo[] = [];
    private pingCache: Map<string, number> = new Map();
    private lastCacheUpdate = 0;
    private cachePromise: Promise<void> | null = null;

    constructor(private readonly axiosService: AxiosService) {}

    async onModuleInit(): Promise<void> {
        await this.refreshCache();

        setInterval(() => {
            if (!this.cachePromise) {
                this.cachePromise = this.refreshCache().finally(() => {
                    this.cachePromise = null;
                });
            }
        }, CACHE_TTL_MS);

        this.logger.log('AutoSelectService initialized');
    }

    public getBestLink(links: string[]): string | null {
        if (links.length === 0) return null;

        const scored = this.scoreLinks(links);
        if (scored.length === 0) return null;

        const best = scored[0]!;

        const hashIndex = best.link.lastIndexOf('#');
        const baseLink = hashIndex !== -1 ? best.link.substring(0, hashIndex) : best.link;

        return `${baseLink}#${encodeURIComponent(`⚡ Автовыбор → ${best.originalName}`)}`;
    }

    private scoreLinks(links: string[]): ScoredServer[] {
        const candidates: ScoredServer[] = [];

        for (const link of links) {
            const parsed = this.parseLinkHost(link);
            if (!parsed) continue;

            const nodeStats = this.findNodeStatsForHost(parsed.hostname);
            const ping = this.pingCache.get(parsed.hostname) ?? PING_TIMEOUT_MS;

            candidates.push({
                link,
                originalName: parsed.name,
                hostname: parsed.hostname,
                score: 0,
                users: nodeStats?.usersOnline ?? 0,
                ping,
                load: nodeStats?.loadAvg[0] ?? 0,
            });
        }

        if (candidates.length === 0) return [];

        const maxUsers = Math.max(...candidates.map((c) => c.users), 1);
        const maxPing = Math.max(...candidates.map((c) => c.ping), 1);
        const maxLoad = Math.max(...candidates.map((c) => c.load), 1);

        for (const candidate of candidates) {
            const scoreUsers = 100 * (1 - candidate.users / maxUsers);
            const scorePing = 100 * (1 - candidate.ping / maxPing);
            const scoreLoad = 100 * (1 - candidate.load / maxLoad);

            candidate.score = 0.35 * scoreUsers + 0.30 * scorePing + 0.35 * scoreLoad;
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates;
    }

    private findNodeStatsForHost(hostname: string): NodeStats | null {
        const host = this.hostCache.find((h) => h.address === hostname);
        if (!host || host.nodeUuids.length === 0) {
            const directMatch = this.nodeStatsCache.find((n) => n.address === hostname);
            return directMatch ?? null;
        }

        const nodeUuid = host.nodeUuids[0]!;
        return this.nodeStatsCache.find((n) => n.nodeUuid === nodeUuid) ?? null;
    }

    private async measurePing(hostname: string, port: number): Promise<number> {
        return new Promise((resolve) => {
            const start = Date.now();
            const socket = net.createConnection(port, hostname, () => {
                const ping = Date.now() - start;
                socket.destroy();
                resolve(ping);
            });

            socket.setTimeout(PING_TIMEOUT_MS, () => {
                socket.destroy();
                resolve(PING_TIMEOUT_MS);
            });

            socket.on('error', () => {
                socket.destroy();
                resolve(PING_TIMEOUT_MS);
            });
        });
    }

    private parseLinkHost(link: string): { hostname: string; port: number; name: string } | null {
        try {
            const withoutProtocol = link.replace(/^[\w+]+:\/\//, '');
            const atSplit = withoutProtocol.split('@');
            if (atSplit.length < 2) return null;

            const hostPortPart = atSplit[1]!.split(/[/?#]/)[0]!;
            const colonIndex = hostPortPart.lastIndexOf(':');
            let hostname: string;
            let port = 443;

            if (colonIndex !== -1) {
                hostname = hostPortPart.substring(0, colonIndex);
                const parsedPort = parseInt(hostPortPart.substring(colonIndex + 1), 10);
                if (!isNaN(parsedPort)) port = parsedPort;
            } else {
                hostname = hostPortPart;
            }

            if (!hostname) return null;

            const hashIndex = link.lastIndexOf('#');
            const name =
                hashIndex !== -1
                    ? decodeURIComponent(link.substring(hashIndex + 1))
                    : 'Unknown';

            return { hostname, port, name };
        } catch {
            return null;
        }
    }

    private async refreshCache(): Promise<void> {
        try {
            const [nodesResult, hostsResult] = await Promise.all([
                this.axiosService.getAllNodes(),
                this.axiosService.getAllHosts(),
            ]);

            if (nodesResult.isOk && nodesResult.response) {
                this.nodeStatsCache = nodesResult.response
                    .filter((node) => node.isConnected && !node.isDisabled)
                    .map((node) => ({
                        nodeUuid: node.uuid,
                        address: node.address,
                        usersOnline: node.usersOnline,
                        loadAvg: node.system?.stats.loadAvg ?? [0, 0, 0],
                        memoryUsed: node.system?.stats.memoryUsed ?? 0,
                        memoryTotal: node.system?.info.memoryTotal ?? 0,
                    }));
            }

            if (hostsResult.isOk && hostsResult.response) {
                this.hostCache = hostsResult.response
                    .filter((host) => !host.isDisabled)
                    .map((host) => ({
                        address: host.address,
                        remark: host.remark,
                        port: host.port,
                        nodeUuids: host.nodes,
                    }));
            }

            const uniqueHosts = new Map<string, number>();
            for (const host of this.hostCache) {
                if (!uniqueHosts.has(host.address)) {
                    uniqueHosts.set(host.address, host.port);
                }
            }

            const pingResults = await Promise.all(
                Array.from(uniqueHosts.entries()).map(([hostname, port]) =>
                    this.measurePing(hostname, port).then((ping) => ({ hostname, ping })),
                ),
            );

            this.pingCache = new Map(pingResults.map((r) => [r.hostname, r.ping]));

            this.lastCacheUpdate = Date.now();

            this.logger.debug(
                `Cache refreshed: ${this.nodeStatsCache.length} nodes, ${this.hostCache.length} hosts, ${this.pingCache.size} pings`,
            );
        } catch (error) {
            this.logger.error('Failed to refresh cache:', error);
        }
    }
}
