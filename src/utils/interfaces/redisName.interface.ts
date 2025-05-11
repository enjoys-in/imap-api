export enum REDIS_KEY_NAME {
    ALL_DOMAINS = 'ALL_DOMAINS',
    MAILS_WITH_ID = 'MAILS_WITH_ID',
    TEMPORARY_STORED_ALL_MAILS = 'TEMPORARY_STORED_ALL_MAILS',
    ALL_MAILS = 'ALL_MAILS',
    ONLY_ATTACHMENTS = 'ONLY_ATTACHMENTS',
    CHANNEL_FOR_MAIL_LOGS = "::channel_for_mail:logs",
    EMAIL_LOGS = "::email:logs",
    MAIL_LOGS = "::mail:logs",
    UNDELIVERED_EMAILS = "::undelivered:emails",
    PVT_KEY = "::pvt::key",
    VERIFY_DOMAIN = "_verify",
    MX_RECORDS = "mx::",
    TRACKING_WITH_ID = "::tracking",
    BLOCKED_IPS = "blocked_ips",
    API_SECRET = "::api_secret",
    API_USED_TIME = "::api_used_time"

}
export enum CHANNEL_NAME {
    SEND_TO_REDIS = "send-to-redis",
    SEND_TO_SOCKET = "send-to-socket",
    UNDELIVERED_MAILS="undelivered-mails"

}