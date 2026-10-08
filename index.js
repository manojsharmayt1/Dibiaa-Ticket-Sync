require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    ComponentType
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const GOOGLE_SCRIPT_URL =
    process.env.GOOGLE_SCRIPT_URL;

const POLL_INTERVAL = 3000;

const processedClaims = new Set();
const processedCloses = new Set();
const processedUsers = new Set();

let scanning = false;


// ==========================================
// SEND DATA TO GOOGLE SHEETS
// ==========================================

async function sendToGoogleSheets(data) {

    try {

        console.log(
            "Sending to Google:",
            JSON.stringify(data)
        );

        const response = await fetch(
            GOOGLE_SCRIPT_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify(data)
            }
        );

        const text =
            await response.text();

        console.log(
            "Google Response:",
            text
        );

        return text;

    } catch (error) {

        console.error(
            "Google Sheets Error:",
            error.message
        );

        return null;
    }
}


// ==========================================
// GET DISCORD USERNAME
// ==========================================

async function getUserName(
    guild,
    userId
) {

    if (!userId) {
        return "";
    }

    try {

        const member =
            await guild.members.fetch(userId);

        return (
            member.user.username ||
            member.user.globalName ||
            member.displayName ||
            ""
        );

    } catch {

        return "";
    }
}


// ==========================================
// GET TICKET ID FROM CHANNEL
// ==========================================

function getTicketIdFromChannel(
    channel
) {

    if (!channel) {
        return null;
    }

    const match =
        channel.name.match(
            /^ticket-(\d+)$/i
        );

    if (!match) {
        return null;
    }

    return match[1];
}


// ==========================================
// GET EMBED FIELD
// ==========================================

function getField(
    embed,
    fieldName
) {

    if (
        !embed ||
        !embed.fields
    ) {
        return "";
    }

    const field =
        embed.fields.find(
            field => {

                const name =
                    String(
                        field.name || ""
                    ).toLowerCase();

                return name.includes(
                    fieldName.toLowerCase()
                );
            }
        );

    return field
        ? String(field.value || "")
        : "";
}


// ==========================================
// EXTRACT DISCORD USER ID
// ==========================================

function extractUserId(text) {

    if (!text) {
        return null;
    }

    const match =
        String(text).match(
            /<@!?(\d+)>/
        );

    return match
        ? match[1]
        : null;
}


// ==========================================
// FIND TICKET CREATOR
// ==========================================

async function getTicketCreator(
    channel,
    guild
) {

    try {

        /*
         * Tickets Bot normally gives the ticket
         * creator a USER-SPECIFIC permission overwrite.
         *
         * Staff roles are ROLE overwrites, so we ignore them.
         */

        const overwrites =
            channel.permissionOverwrites.cache;

        for (
            const [
                id,
                overwrite
            ] of overwrites
        ) {

            // Only user-specific overwrite
            if (
                overwrite.type !== 1
            ) {
                continue;
            }

            // Ignore our own bot
            if (
                id === client.user.id
            ) {
                continue;
            }

            try {

                const member =
                    await guild.members.fetch(id);

                // Ignore bots
                if (
                    member.user.bot
                ) {
                    continue;
                }

                /*
                 * Return actual Discord username.
                 *
                 * Example:
                 * it_dibiaa
                 */

                const username =
                    member.user.username;

                if (!username) {
                    continue;
                }

                return {
                    userId: member.id,
                    username: username
                };

            } catch {

                continue;
            }
        }

    } catch (error) {

        console.error(
            "Ticket creator detection error:",
            error.message
        );
    }

    return null;
}


// ==========================================
// PROCESS TICKET CREATOR
// ==========================================

async function processTicketCreator(
    channel,
    guild
) {

    const ticketId =
        getTicketIdFromChannel(
            channel
        );

    if (!ticketId) {
        return;
    }

    /*
     * Already processed?
     */

    if (
        processedUsers.has(ticketId)
    ) {
        return;
    }

    const creator =
        await getTicketCreator(
            channel,
            guild
        );

    /*
     * Creator not found yet.
     * Don't mark it as processed.
     * Next 3-second scan will try again.
     */

    if (!creator) {
        return;
    }

    processedUsers.add(
        ticketId
    );

    console.log("");
    console.log(
        "================================="
    );

    console.log(
        "TICKET CREATOR DETECTED"
    );

    console.log(
        "Ticket:",
        ticketId
    );

    console.log(
        "Discord User:",
        creator.username
    );

    console.log(
        "================================="
    );


    /*
     * IMPORTANT:
     *
     * We intentionally send the username
     * in user_id because you requested:
     *
     * User ID column = Discord username
     */

    await sendToGoogleSheets({

        action: "update_user",

        ticket_id:
            ticketId,

        user_name:
            creator.username
    });
}


// ==========================================
// GET TRANSCRIPT LINK
// ==========================================

function getTranscriptLink(
    message
) {

    try {

        for (
            const row
            of message.components || []
        ) {

            for (
                const component
                of row.components || []
            ) {

                if (
                    component.type ===
                    ComponentType.Button
                ) {

                    const label =
                        String(
                            component.label ||
                            ""
                        ).toLowerCase();

                    if (
                        label.includes(
                            "view online transcript"
                        ) &&
                        component.url
                    ) {

                        return component.url;
                    }
                }
            }
        }

    } catch (error) {

        console.log(
            "Transcript button read error:",
            error.message
        );
    }

    return "";
}


// ==========================================
// PROCESS CLAIM
// ==========================================

async function processClaim(
    message,
    guild
) {

    if (
        processedClaims.has(
            message.id
        )
    ) {
        return;
    }

    const ticketId =
        getTicketIdFromChannel(
            message.channel
        );

    if (!ticketId) {
        return;
    }

    const claimEmbed =
        message.embeds.find(
            embed => {

                const title =
                    String(
                        embed.title || ""
                    ).toLowerCase();

                return title.includes(
                    "claimed ticket"
                );
            }
        );

    if (!claimEmbed) {
        return;
    }

    processedClaims.add(
        message.id
    );

    const description =
        claimEmbed.description || "";

    const claimedUserId =
        extractUserId(
            description
        );

    let claimedBy = "";

    if (claimedUserId) {

        claimedBy =
            await getUserName(
                guild,
                claimedUserId
            );

    } else {

        claimedBy =
            description
                .replace(
                    /<@!?\d+>/g,
                    ""
                )
                .trim();
    }

    console.log("");
    console.log(
        "================================="
    );

    console.log(
        "CLAIM DETECTED"
    );

    console.log(
        "Ticket:",
        ticketId
    );

    console.log(
        "Claimed By:",
        claimedBy
    );

    console.log(
        "Message:",
        message.id
    );

    console.log(
        "================================="
    );


    await sendToGoogleSheets({

        action: "claim",

        ticket_id:
            ticketId,

        claimed_by:
            claimedBy
    });
}


// ==========================================
// PROCESS CLOSE
// ==========================================

async function processClose(
    message,
    guild
) {

    if (
        processedCloses.has(
            message.id
        )
    ) {
        return;
    }

    const closeEmbed =
        message.embeds.find(
            embed => {

                const title =
                    String(
                        embed.title || ""
                    ).toLowerCase();

                return title.includes(
                    "ticket closed"
                );
            }
        );

    if (!closeEmbed) {
        return;
    }

    const ticketId =
        getField(
            closeEmbed,
            "Ticket ID"
        ).trim();

    if (!ticketId) {
        return;
    }

    processedCloses.add(
        message.id
    );


    // ======================================
    // CLOSED BY
    // ======================================

    const closedByText =
        getField(
            closeEmbed,
            "Closed By"
        );

    const closedById =
        extractUserId(
            closedByText
        );

    let closedBy =
        closedByText;

    if (closedById) {

        const discordName =
            await getUserName(
                guild,
                closedById
            );

        if (discordName) {
            closedBy =
                discordName;
        }
    }


    // ======================================
    // CLAIMED BY
    // ======================================

    const claimedByText =
        getField(
            closeEmbed,
            "Claimed By"
        );

    const claimedById =
        extractUserId(
            claimedByText
        );

    let claimedBy =
        claimedByText;

    if (claimedById) {

        const discordName =
            await getUserName(
                guild,
                claimedById
            );

        if (discordName) {
            claimedBy =
                discordName;
        }
    }


    // ======================================
    // TRANSCRIPT
    // ======================================

    let transcript =
        getTranscriptLink(
            message
        );

    if (!transcript) {

        transcript =
            message.url;
    }


    // ======================================
    // CLOSE TIME
    // ======================================

    const closeTime =
        message.createdAt.toISOString();


    console.log("");
    console.log(
        "================================="
    );

    console.log(
        "CLOSE DETECTED"
    );

    console.log(
        "Ticket:",
        ticketId
    );

    console.log(
        "Closed By:",
        closedBy
    );

    console.log(
        "Claimed By:",
        claimedBy
    );

    console.log(
        "Transcript:",
        transcript
    );

    console.log(
        "================================="
    );


    await sendToGoogleSheets({

        action: "close",

        ticket_id:
            ticketId,

        closed_by:
            closedBy,

        claimed_by:
            claimedBy,

        close_time:
            closeTime,

        transcript:
            transcript
    });
}


// ==========================================
// SCAN TRANSCRIPT CHANNEL
// ==========================================

async function scanTranscriptChannel(
    guild
) {

    const transcriptChannel =
        guild.channels.cache.find(
            channel =>
                channel.isTextBased() &&
                channel.name.toLowerCase() ===
                "transcript"
        );

    if (!transcriptChannel) {

        console.log(
            "Transcript channel not found"
        );

        return;
    }

    try {

        const messages =
            await transcriptChannel.messages.fetch({
                limit: 50
            });

        for (
            const message
            of messages.values()
        ) {

            await processClose(
                message,
                guild
            );
        }

    } catch (error) {

        console.error(
            "Transcript scan error:",
            error.message
        );
    }
}


// ==========================================
// SCAN ACTIVE TICKET CHANNELS
// ==========================================

async function scanTicketChannels(
    guild
) {

    const ticketChannels =
        guild.channels.cache.filter(
            channel =>
                channel.isTextBased() &&
                /^ticket-\d+$/i.test(
                    channel.name
                )
        );

    for (
        const channel
        of ticketChannels.values()
    ) {

        try {

            // ==================================
            // DETECT TICKET CREATOR
            // ==================================

            await processTicketCreator(
                channel,
                guild
            );


            // ==================================
            // GET TICKET MESSAGES
            // ==================================

            const messages =
                await channel.messages.fetch({
                    limit: 30
                });

            for (
                const message
                of messages.values()
            ) {

                await processClaim(
                    message,
                    guild
                );
            }

        } catch (error) {

            console.error(
                `Ticket channel scan error (${channel.name}):`,
                error.message
            );
        }
    }
}


// ==========================================
// COMPLETE SCAN
// ==========================================

async function scanEverything() {

    if (scanning) {
        return;
    }

    scanning = true;

    try {

        const guild =
            client.guilds.cache.first();

        if (!guild) {

            console.log(
                "No Discord server found"
            );

            return;
        }

        await guild.channels.fetch();

        await scanTranscriptChannel(
            guild
        );

        await scanTicketChannels(
            guild
        );

    } catch (error) {

        console.error(
            "Scan error:",
            error
        );

    } finally {

        scanning = false;
    }
}


// ==========================================
// BOT READY
// ==========================================

client.once(
    "clientReady",
    async () => {

        console.log("");
        console.log(
            "================================="
        );

        console.log(
            `Bot Online: ${client.user.tag}`
        );

        console.log(
            `Servers: ${client.guilds.cache.size}`
        );

        console.log(
            "Dibiaa Ticket Sync READY"
        );

        console.log(
            `Polling every ${POLL_INTERVAL / 1000} seconds`
        );

        console.log(
            "================================="
        );

        await scanEverything();

        setInterval(
            scanEverything,
            POLL_INTERVAL
        );
    }
);


// ==========================================
// ERROR HANDLING
// ==========================================

client.on(
    "error",
    error => {

        console.error(
            "Discord Client Error:",
            error
        );
    }
);


// ==========================================
// LOGIN
// ==========================================

client.login(
    process.env.DISCORD_BOT_TOKEN
);