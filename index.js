require("dotenv").config();

const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {

    res.writeHead(200, {
        "Content-Type": "text/plain"
    });

    res.end(
        "Dibiaa Ticket Sync Bot is running"
    );

}).listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `HTTP server running on port ${PORT}`
        );
    }
);


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


// ==========================================
// PROCESSED SETS
// ==========================================

const processedClaims =
    new Set();

const processedCloses =
    new Set();

const processedUsers =
    new Set();


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


        const response =
            await fetch(
                GOOGLE_SCRIPT_URL,
                {

                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(data)

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
            await guild.members.fetch(
                userId
            );


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


    if (
        processedUsers.has(
            ticketId
        )
    ) {
        return;
    }


    const creator =
        await getTicketCreator(
            channel,
            guild
        );


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


    await sendToGoogleSheets({

        action:
            "update_user_id",

        ticket_id:
            ticketId,

        user_id:
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
        claimEmbed.description ||
        "";


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

        action:
            "claim",

        ticket_id:
            ticketId,

        claimed_by:
            claimedBy

    });
}



async function processClose(message, guild) {
    if (processedCloses.has(message.id)) {
        return;
    }

    const closeEmbed = message.embeds.find(embed => {
        const title = String(embed.title || "").toLowerCase();
        return title.includes("ticket closed");
    });

    if (!closeEmbed) return;

    const ticketId = getField(closeEmbed, "Ticket ID").trim();
    if (!ticketId) return;

    processedCloses.add(message.id);

    // CLOSED BY
    const closedByText = getField(closeEmbed, "Closed By");
    const closedById = extractUserId(closedByText);
    let closedBy = closedByText;

    if (closedById) {
        const discordName = await getUserName(guild, closedById);
        if (discordName) closedBy = discordName;
    }

    // CLAIMED BY
    const claimedByText = getField(closeEmbed, "Claimed By");
    const claimedById = extractUserId(claimedByText);
    let claimedBy = claimedByText;

    if (claimedById) {
        const discordName = await getUserName(guild, claimedById);
        if (discordName) claimedBy = discordName;
    }

    // CLOSE WITH REASON
    let closeReason =
        getField(closeEmbed, "Close Reason").trim();

    if (!closeReason) {
        closeReason = getField(closeEmbed, "Reason").trim();
    }

    // Embed description se reason nikalna
    if (!closeReason && closeEmbed.description) {
        const match = closeEmbed.description.match(
            /(?:close\s*)?reason\s*:\s*([\s\S]+)/i
        );

        if (match) {
            closeReason = match[1].trim();
        }
    }

    // Empty/placeholder reason ko blank rakho
    if (/^(none|n\/a|not provided|no reason)$/i.test(closeReason)) {
        closeReason = "";
    }

    // TRANSCRIPT LINK
    let transcript = getTranscriptLink(message);

    if (!transcript) {
        transcript = message.url;
    }

    // CLOSE TIME
    const closeTime = message.createdAt.toISOString();

    // LOGS
    console.log("=================================");
    console.log("CLOSE DETECTED");
    console.log("Ticket:", ticketId);
    console.log("Closed By:", closedBy);
    console.log("Claimed By:", claimedBy);
    console.log("Close Reason:", closeReason || "(reason not found)");
    console.log("Transcript:", transcript);
    console.log("=================================");

    // GOOGLE SHEETS
    await sendToGoogleSheets({
        action: "close",
        ticket_id: ticketId,
        closed_by: closedBy,
        claimed_by: claimedBy,
        close_time: closeTime,
        close_reason: closeReason,
        transcript: transcript
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

                channel.name
                    .toLowerCase() ===
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
            await transcriptChannel
                .messages.fetch({
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

            // Creator
            await processTicketCreator(
                channel,
                guild
            );


            // Messages
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


        // ==================================
        // TRANSCRIPTS
        // ==================================

        await scanTranscriptChannel(
            guild
        );


        // ==================================
        // ACTIVE TICKETS
        // ==================================

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
            "User ID column sync: Discord username"
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
