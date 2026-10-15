
require("dotenv").config();

const http = require("http");

const PORT = process.env.PORT || 3000;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const POLL_INTERVAL = 3000;
const NUMERIC_USER_SYNC_INTERVAL = 30000;

const {
    Client,
    GatewayIntentBits,
    ComponentType
} = require("discord.js");

// ---------------- HTTP HEALTH CHECK ----------------

http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
        success: true,
        service: "Dibiaa Ticket Sync Bot",
        status: "running",
        discordReady: client.isReady()
    }));
}).listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server running on port ${PORT}`);
});

// ---------------- VALIDATE ENVIRONMENT ----------------

if (!GOOGLE_SCRIPT_URL) {
    console.error("Missing GOOGLE_SCRIPT_URL environment variable");
}

if (!DISCORD_BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN environment variable");
}

// ---------------- DISCORD CLIENT ----------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const processedClaims = new Set();
const processedCloses = new Set();
const processedUsers = new Set();

let lastNumericUserSync = 0;
let scanning = false;

// ---------------- GOOGLE SHEETS ----------------

async function sendToGoogleSheets(data) {
    if (!GOOGLE_SCRIPT_URL) {
        console.error("Cannot send to Google: URL is missing");
        return null;
    }

    try {
        console.log("Sending to Google:", JSON.stringify(data));

        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(20000)
        });

        const text = await response.text();

        console.log("Google HTTP status:", response.status);
        console.log("Google Response:", text);

        if (!response.ok) {
            console.error("Google HTTP request failed");
            return null;
        }

        return text;
    } catch (error) {
        console.error("Google Sheets Error:", error.message);
        return null;
    }
}

// ---------------- USERNAME LOOKUP ----------------

async function getUserName(guild, userId) {
    if (!userId) return "";

    try {
        const member = await guild.members.fetch(userId);

        return member.user.username ||
            member.user.globalName ||
            member.displayName ||
            "";
    } catch (error) {
        console.warn(
            `Username lookup failed for ${userId}:`,
            error.message
        );
        return "";
    }
}

// ---------------- NUMERIC USER ID SYNC ----------------

async function syncNumericUserIds(guild) {
    try {
        console.log("Checking old numeric User IDs...");

        const response = await sendToGoogleSheets({
            action: "get_numeric_users"
        });

        if (!response) return;

        let result;

        try {
            result = JSON.parse(response);
        } catch {
            console.error("Invalid Google response for numeric users");
            return;
        }

        if (!result.success || !Array.isArray(result.users)) {
            console.log("No numeric users returned");
            return;
        }

        for (const row of result.users) {
            const ticketId = String(row.ticket_id || "").trim();
            const userId = String(row.user_id || "").trim();

            if (!ticketId || !userId) continue;

            const username = await getUserName(guild, userId);

            if (!username) continue;

            await sendToGoogleSheets({
                action: "update_user",
                ticket_id: ticketId,
                user_name: username
            });

            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log("Numeric User ID sync complete");
    } catch (error) {
        console.error("Numeric user sync error:", error.message);
    }
}

// ---------------- TICKET ID ----------------

function getTicketIdFromChannel(channel) {
    if (!channel || !channel.name) return null;

    const match = channel.name.match(/^ticket-(\d+)$/i);
    return match ? match[1] : null;
}

// ---------------- EMBED FIELD ----------------

function getField(embed, fieldName) {
    if (!embed || !embed.fields) return "";

    const target = fieldName.toLowerCase();

    const field = embed.fields.find(item =>
        String(item.name || "").toLowerCase().includes(target)
    );

    return field ? String(field.value || "").trim() : "";
}

function extractUserId(text) {
    if (!text) return null;

    const match = String(text).match(/<@!?(\d+)>/);
    return match ? match[1] : null;
}

// ---------------- FIND TICKET CREATOR ----------------

async function getTicketCreator(channel, guild) {
    try {
        const overwrites = channel.permissionOverwrites.cache;

        for (const [id, overwrite] of overwrites) {
            // Only user-specific permission overwrites.
            if (overwrite.type !== 1) continue;
            if (id === client.user.id) continue;

            try {
                const member = await guild.members.fetch(id);

                if (member.user.bot) continue;

                return {
                    userId: member.id,
                    username: member.user.username
                };
            } catch {
                continue;
            }
        }
    } catch (error) {
        console.error(
            `Creator detection failed in ${channel.name}:`,
            error.message
        );
    }

    return null;
}

// ---------------- PROCESS TICKET CREATOR ----------------

async function processTicketCreator(channel, guild) {
    const ticketId = getTicketIdFromChannel(channel);

    if (!ticketId || processedUsers.has(ticketId)) return;

    const creator = await getTicketCreator(channel, guild);

    if (!creator) return;

    const response = await sendToGoogleSheets({
        action: "update_user",
        ticket_id: ticketId,
        user_name: creator.username
    });

    if (response) {
        processedUsers.add(ticketId);
        console.log(
            `Ticket creator synced: ${ticketId} / ${creator.username}`
        );
    }
}

// ---------------- TRANSCRIPT LINK ----------------

function getTranscriptLink(message) {
    try {
        for (const row of message.components || []) {
            for (const component of row.components || []) {
                if (component.type !== ComponentType.Button) continue;

                const label = String(component.label || "").toLowerCase();

                if (
                    label.includes("view online transcript") &&
                    component.url
                ) {
                    return component.url;
                }
            }
        }
    } catch (error) {
        console.warn("Transcript button read error:", error.message);
    }

    return "";
}

// ---------------- PROCESS CLAIM ----------------

async function processClaim(message, guild) {
    if (processedClaims.has(message.id)) return;

    const ticketId = getTicketIdFromChannel(message.channel);
    if (!ticketId) return;

    const claimEmbed = message.embeds.find(embed =>
        String(embed.title || "").toLowerCase().includes("claimed ticket")
    );

    if (!claimEmbed) return;

    const description = claimEmbed.description || "";
    const claimedUserId = extractUserId(description);

    let claimedBy = "";

    if (claimedUserId) {
        claimedBy = await getUserName(guild, claimedUserId);
    } else {
        claimedBy = description.replace(/<@!?\d+>/g, "").trim();
    }

    if (!claimedBy) {
        console.warn(`Claim detected but username missing for ticket ${ticketId}`);
        return;
    }

    const response = await sendToGoogleSheets({
        action: "claim",
        ticket_id: ticketId,
        claimed_by: claimedBy
    });

    if (response) {
        processedClaims.add(message.id);
        console.log(`Claim synced: ticket ${ticketId}, by ${claimedBy}`);
    }
}

// ---------------- PROCESS CLOSE ----------------

async function processClose(message, guild) {
    if (processedCloses.has(message.id)) return;

    const closeEmbed = message.embeds.find(embed =>
        String(embed.title || "").toLowerCase().includes("ticket closed")
    );

    if (!closeEmbed) return;

    const ticketId = getField(closeEmbed, "Ticket ID");

    if (!ticketId) {
        console.warn("Close embed found, but Ticket ID field is missing");
        return;
    }

    const closedByText = getField(closeEmbed, "Closed By");
    const claimedByText = getField(closeEmbed, "Claimed By");

    const closedById = extractUserId(closedByText);
    const claimedById = extractUserId(claimedByText);

    let closedBy = closedByText;
    let claimedBy = claimedByText;

    if (closedById) {
        closedBy = (await getUserName(guild, closedById)) || closedByText;
    }

    if (claimedById) {
        claimedBy = (await getUserName(guild, claimedById)) || claimedByText;
    }

    let transcript = getTranscriptLink(message);

    // Fallback to the close message URL if there is no transcript button.
    if (!transcript) transcript = message.url;

    const closeTime = message.createdAt.toISOString();

    console.log("Close event detected:", {
        ticketId,
        closedBy,
        claimedBy,
        transcript,
        closeTime
    });

    const response = await sendToGoogleSheets({
        action: "close",
        ticket_id: ticketId,
        closed_by: closedBy,
        claimed_by: claimedBy,
        close_time: closeTime,
        transcript
    });

    if (response) {
        try {
            const result = JSON.parse(response);

            if (result.success === false) {
                console.error("Google rejected close update:", result.error);
                return;
            }
        } catch {
            console.warn("Google close response was not JSON");
        }

        processedCloses.add(message.id);
        console.log(`Close event synced for ticket ${ticketId}`);
    }
}

// ---------------- SCAN TRANSCRIPT CHANNEL ----------------

async function scanTranscriptChannel(guild) {
    const transcriptChannel = guild.channels.cache.find(channel =>
        channel.isTextBased() &&
        channel.name.toLowerCase() === "transcript"
    );

    if (!transcriptChannel) {
        console.warn("Transcript channel not found");
        return;
    }

    try {
        const messages = await transcriptChannel.messages.fetch({
            limit: 50
        });

        for (const message of messages.values()) {
            await processClose(message, guild);
        }
    } catch (error) {
        console.error(
            `Transcript scan error in #${transcriptChannel.name} ` +
            `(channel ID ${transcriptChannel.id}):`,
            `code=${error.code || "unknown"}`,
            error.message
        );
    }
}

// ---------------- SCAN ACTIVE TICKET CHANNELS ----------------

async function scanTicketChannels(guild) {
    const ticketChannels = guild.channels.cache.filter(channel =>
        channel.isTextBased() &&
        /^ticket-\d+$/i.test(channel.name)
    );

    for (const channel of ticketChannels.values()) {
        try {
            await processTicketCreator(channel, guild);

            const messages = await channel.messages.fetch({
                limit: 30
            });

            for (const message of messages.values()) {
                await processClaim(message, guild);

                // FIX: also check close embeds in ticket channels.
                await processClose(message, guild);
            }
        } catch (error) {
            console.error(
                `Ticket channel scan error in #${channel.name} ` +
                `(channel ID ${channel.id}):`,
                `code=${error.code || "unknown"}`,
                error.message
            );
        }
    }
}

// ---------------- COMPLETE SCAN ----------------

async function scanEverything() {
    if (scanning) return;

    scanning = true;

    try {
        const guild = client.guilds.cache.first();

        if (!guild) {
            console.warn("No Discord server found");
            return;
        }

        await guild.channels.fetch();

        const now = Date.now();

        if (now - lastNumericUserSync >= NUMERIC_USER_SYNC_INTERVAL) {
            lastNumericUserSync = now;
            await syncNumericUserIds(guild);
        }

        await scanTranscriptChannel(guild);
        await scanTicketChannels(guild);
    } catch (error) {
        console.error("Full scan error:", error);
    } finally {
        scanning = false;
    }
}

// ---------------- BOT READY ----------------

client.once("clientReady", async () => {
    console.log("=================================");
    console.log(`Bot Online: ${client.user.tag}`);
    console.log(`Servers: ${client.guilds.cache.size}`);
    console.log("Dibiaa Ticket Sync READY");
    console.log(`Polling every ${POLL_INTERVAL / 1000} seconds`);
    console.log("=================================");

    await scanEverything();

    setInterval(() => {
        scanEverything().catch(error =>
            console.error("Scheduled scan failed:", error)
        );
    }, POLL_INTERVAL);
});

// ---------------- ERROR HANDLING ----------------

client.on("error", error => {
    console.error("Discord Client Error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled promise rejection:", error);
});

// ---------------- LOGIN ----------------

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN).catch(error => {
        console.error("Discord login failed:", error.message);
    });
}
