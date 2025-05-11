import axios from "axios";
const webadmin_state = (access_token: string, refresh_token: string) => ({
    "base_url": "",
    access_token, refresh_token, "username": "admin",
    "is_valid": true,
    "is_enterprise": false,
    "permissions": [
        "group-create",
        "principal-list",
        "oauth-client-list",
        "spam-filter-train",
        "settings-reload",
        "mailing-list-create",
        "group-get",
        "incoming-report-delete",
        "outgoing-report-get",
        "purge-account",
        "role-update",
        "domain-get",
        "tenant-get",
        "unlimited-requests",
        "manage-passwords",
        "group-list",
        "individual-update",
        "message-queue-update",
        "settings-update",
        "tracing-live",
        "tenant-create",
        "message-queue-list",
        "unlimited-uploads",
        "tenant-update",
        "individual-list",
        "unknown",
        "purge-blob-store",
        "principal-get",
        "tracing-list",
        "tenant-delete",
        "impersonate",
        "incoming-report-list",
        "dkim-signature-get",
        "webadmin-update",
        "metrics-live",
        "spam-filter-update",
        "restart",
        "oauth-client-delete",
        "api-key-update",
        "tenant-list",
        "api-key-get",
        "domain-list",
        "api-key-list",
        "individual-delete",
        "group-update",
        "outgoing-report-delete",
        "purge-data-store",
        "dkim-signature-create",
        "undelete",
        "metrics-list",
        "api-key-delete",
        "manage-encryption",
        "group-delete",
        "outgoing-report-list",
        "role-get",
        "principal-update",
        "role-list",
        "tracing-get",
        "role-delete",
        "mailing-list-get",
        "logs-view",
        "troubleshoot",
        "oauth-client-create",
        "message-queue-get",
        "oauth-client-get",
        "settings-delete",
        "incoming-report-get",
        "domain-update",
        "individual-create",
        "principal-delete",
        "api-key-create",
        "domain-delete",
        "mailing-list-update",
        "domain-create",
        "mailing-list-list",
        "role-create",
        "delete-system-folders",
        "purge-in-memory-store",
        "fts-reindex",
        "mailing-list-delete",
        "oauth-client-update",
        "settings-list",
        "message-queue-delete",
        "principal-create",
        "blob-fetch",
        "individual-get"
    ]
})
export class StalwartService {
    private axiosInstance: axios.AxiosInstance;
    private authConfig: Root = {
        access_token: "",
        token_type: "",
        expires_in: 0,
        refresh_token: "",
        id_token: "",
    };
    constructor(private readonly baseUrl: string) {
        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                authorization: "Basic YWRtaW46bnNxVzc4RVJ4WA==",
                "cache-control": "no-cache",
            },
        });
        // Request interceptor: set User-Agent
        this.axiosInstance.interceptors.request.use((config) => {
            config.headers["User-Agent"] =
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
            return config;
        });

        // Response interceptor: handle 401
        this.axiosInstance.interceptors.response.use(
            (response) => response, // return response if successful
            async (error) => {
                const originalRequest = error.config;

                if (
                    error.response &&
                    error.response.status === 401 &&
                    !originalRequest._retry
                ) {
                    originalRequest._retry = true;
                    try {
                        await this.auth(); // your re-authentication logic
                        return this.axiosInstance(originalRequest); // retry the request
                    } catch (authError) {
                        return Promise.reject(authError);
                    }
                }

                return Promise.reject(error);
            }
        );
    }
    private oauth() {
        return this.axiosInstance.post("/api/oauth", {
            type: "code",
            client_id: "webadmin",
            redirect_uri: "stalwart://auth",
            nonce: "hD3ujC8mDo",
        });
    }
    private async token(code: string) {
        const res = await this.axiosInstance.post(
            `${this.baseUrl}/auth/token`,
            `grant_type=authorization_code&client_id=webadmin&code=${code}&redirect_uri=stalwart://auth`,
            {
                headers: {
                    Accept: "*/*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );
        this.authConfig = res.data;
        this.axiosInstance.defaults.headers.common[
            "Authorization"
        ] = `Bearer ${this.authConfig.access_token}`;
        return res.data as Root;
    }

    async auth() {
        const { data } = await this.oauth();
        return this.token(data.data.code);
    }
    async getUserAccount() {
        const { data } = await this.axiosInstance.get("/api/principal", {
            params: {
                limit: 10,
                types: "individual",
                page: 1,
            },
            headers: {
                Accept: "*/*",

                Authorization: "Bearer " + this.authConfig.access_token,
            },
            httpsAgent: new (require("https").Agent)({
                rejectUnauthorized: false,
            }),
        });

        return data;
    }
    async handleUser(email: string, aliases: string[] = []) {
        const { data } = await this.axiosInstance.post(
            "/api/principal",
            {
                type: "individual",
                quota: 1073741824, // 1GB
                name: email,
                description: "No description",
                secrets: [
                    "$6$mPNlDsA7Xvv0VkYT$pCY68lUuDq5G0rAU.yaFPYY5K.TrVN7cnaFTphHOAz6AYyUuRE6Ens4u5HXLvlgkFaR/2ebSt2n9GwushwGE8.",
                ], //$6$<salt>$<hashed password>
                emails: Array.from(new Set([email, ...aliases])),
                urls: [],
                memberOf: [],
                roles: ["user"],
                lists: [],
                members: [],
                enabledPermissions: [],
                disabledPermissions: [],
                externalMembers: [],
            },
            {
                headers: {
                    Authorization: `Bearer ${this.authConfig.access_token}`,
                },
            }
        );

        return data;
    }
    async deleteUser(login_name: string) {
        const { data } = await axios.delete<StalwartResponse<null>>(
            `/api/principal/${login_name}`,
            {
                headers: {
                    Authorization: "Bearer " + this.authConfig.access_token,
                },
            }
        );

        return data;
    }
    async updateUserPassword() { }
    async getDomains() {
        const { data } = await this.axiosInstance.get<
            StalwartResponse<GetAllDomainsResponse>
        >("/api/principal", {
            params: {
                limit: 50,
                types: "domain",
                page: 1,
            },
            headers: {
                Accept: "*/*",
                Authorization: "Bearer " + this.authConfig.access_token,
            },
            httpsAgent: new (require("https").Agent)({
                rejectUnauthorized: false,
            }),
        });

        return data;
    }
    async addDomain(domain: string) {
        const { data } = await this.axiosInstance.post<StalwartResponse<1>>(
            "/api/principal",
            {
                type: "domain",
                quota: 0,
                name: domain,
                description: "No description",
                secrets: [],
                emails: [],
                urls: [],
                memberOf: [],
                roles: [],
                lists: [],
                members: [],
                enabledPermissions: [],
                disabledPermissions: [],
                externalMembers: [],
            },
            {
                headers: {
                    Authorization: "Bearer " + this.authConfig.access_token,
                },
            }
        );
        await this.addDKim(domain, "Rsa");
        await this.addDKim(domain, "Ed25519");
        return data;
    }
    async getDomainsDns(domain: string) {
        const { data } = await this.axiosInstance.get<
            StalwartResponse<DomainDNSRecords[]>
        >(`/api/dns/records/${domain}`, {
            headers: {
                Accept: "*/*",
                "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
                Authorization: "Bearer " + this.authConfig.access_token,
            },
        });
        return data;
    }
    async addDKim(domain: string, algorithm: "Rsa" | "Ed25519") {
        const { data } = await axios.post(
            "http://185.193.19.118:8080/api/dkim",
            {
                id: null,
                algorithm,
                domain,
                selector: "default",
            },
            {
                headers: {
                    Accept: "*/*",
                    "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
                    Authorization: "Bearer " + this.authConfig.access_token,
                },
            }
        );
        return data;
    }
    async deleteDomain(domain: string) { }
}

interface Root {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    id_token: string;
}
export interface StalwartResponse<T> {
    data: T;
}

export interface GetAllDomainsResponse {
    items: Item[];
    total: number;
}

interface Item {
    id: number;
    type: string;
    members: number;
    quota: number;
    description: string;
    name: string;
}
interface DomainDNSRecords {
    type: string;
    name: string;
    content: string;
}

function generateZoneFile(data: any[]) {
    const lines = [];

    lines.push(`$TTL 3600`);
    lines.push(`@   IN  SOA ns1.enjoys.in. admin.airsend.in. (`);
    lines.push(`        2025041201 ; Serial`);
    lines.push(`        3600       ; Refresh`);
    lines.push(`        1800       ; Retry`);
    lines.push(`        1209600    ; Expire`);
    lines.push(`        86400      ; Minimum TTL`);
    lines.push(`)`);
    lines.push(`    IN  NS  ns1.enjoys.in.`);
    lines.push(`    IN  NS  ns2.enjoys.in.\n`);

    for (const record of data) {
        const { type, name, content } = record;
        switch (type) {
            case "MX":
                lines.push(`${name} IN MX ${content}`);
                break;
            case "CNAME":
                lines.push(`${name} IN CNAME ${content}`);
                break;
            case "TXT":
                // Safely wrap TXT content
                lines.push(`${name} IN TXT "${content}"`);
                break;
            case "SRV":
                // Format: priority weight port target
                const [priority, weight, port, target] = content.split(" ");
                lines.push(`${name} IN SRV ${priority} ${weight} ${port} ${target}`);
                break;
            default:
                lines.push(`; Unknown type: ${type}`);
        }
    }

    return lines.join("\n");
}
