const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    Collection,
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
} = require('discord.js');

const schedule = require('node-schedule');
const fs = require('fs');
require('dotenv').config();

const fetch = globalThis.fetch;

// Credenciais — vêm do .env (nunca commitar)
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const GELBOORU_API_KEY  = process.env.GELBOORU_API_KEY;
const GELBOORU_USER_ID  = process.env.GELBOORU_USER_ID;

if (!DISCORD_TOKEN || !GELBOORU_API_KEY || !GELBOORU_USER_ID) {
    console.error("❌ Credenciais faltando no .env! Verifique DISCORD_TOKEN, GELBOORU_API_KEY e GELBOORU_USER_ID.");
    process.exit(1);
}

// Configurações do bot — ficam no config.json (pode compartilhar)
let config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

// ==================== GELBOORU ====================
// Rating: general, sensitive, questionable, explicit
function toGelbooruRating(rating) {
    const map = { general: "general", safe: "general", sensitive: "sensitive", questionable: "questionable", explicit: "explicit" };
    return map[rating] || "sensitive";
}

function gelbooruParams(extra = {}) {
    return new URLSearchParams({
        page:    "dapi",
        s:       "post",
        q:       "index",
        json:    "1",
        api_key: GELBOORU_API_KEY,
        user_id: GELBOORU_USER_ID,
        ...extra,
    });
}

async function getImages(tags = "", rating = "sensitive", limit = 1, scoreExpr = null) {
    const ratingTag = `rating:${toGelbooruRating(rating)}`;
    let finalTags = [tags?.trim(), ratingTag, scoreExpr ? `score:${scoreExpr}` : ""]
        .filter(Boolean).join(" ").trim();

    // Gelbooru: pega até 100 posts aleatórios usando pid aleatório
    const pid = Math.floor(Math.random() * 50); // página aleatória
    const params = gelbooruParams({ tags: finalTags, limit: 100, pid });
    const url = `https://gelbooru.com/index.php?${params}`;

    try {
        const res = await fetch(url, { headers: { "User-Agent": "DiscordBot/1.0" } });
        if (!res.ok) {
            console.error(`[Gelbooru] ${res.status} — ${url}`);
            return { error: "⚠️ Erro ao conectar com o Gelbooru." };
        }

        const data = await res.json();
        const posts = data?.post;

        if (!Array.isArray(posts) || posts.length === 0) {
            // Tenta sem pid aleatório (página 0)
            if (pid > 0) {
                const params2 = gelbooruParams({ tags: finalTags, limit: 100, pid: 0 });
                const res2 = await fetch(`https://gelbooru.com/index.php?${params2}`, { headers: { "User-Agent": "DiscordBot/1.0" } });
                if (res2.ok) {
                    const data2 = await res2.json();
                    const posts2 = data2?.post;
                    if (Array.isArray(posts2) && posts2.length > 0) {
                        return pickImages(posts2, limit, finalTags);
                    }
                }
            }
            const suggestions = await getTagSuggestions(tags);
            return { error: `❌ Nenhuma imagem encontrada para **${finalTags}**.`, suggestions };
        }

        return pickImages(posts, limit, finalTags);

    } catch (err) {
        console.error("Erro ao buscar imagens:", err);
        return { error: "⚠️ Ocorreu um erro ao buscar imagens." };
    }
}

function pickImages(posts, limit, finalTags) {
    const valid = posts.filter(p =>
        p.file_url &&
        ["jpg", "jpeg", "png", "gif", "webp"].includes(p.image?.split(".").pop()?.toLowerCase() || "")
    );

    if (valid.length === 0) return { error: "❌ Nenhuma imagem válida encontrada." };

    const shuffled = valid.sort(() => Math.random() - 0.5);
    const chosen   = shuffled.slice(0, Math.min(limit, shuffled.length));
    const urls     = chosen.map(p => p.file_url);

    console.log(`[Gelbooru] ${urls.length} imagens — tags: ${finalTags}`);
    return { images: urls };
}

async function getTagSuggestions(tag) {
    if (!tag || tag.startsWith("-")) return [];
    const params = new URLSearchParams({
        page:    "dapi",
        s:       "tag",
        q:       "index",
        json:    "1",
        api_key: GELBOORU_API_KEY,
        user_id: GELBOORU_USER_ID,
        name_pattern: `${tag.trim()}%`,
        orderby: "count",
        limit:   5,
    });
    try {
        const res = await fetch(`https://gelbooru.com/index.php?${params}`, { headers: { "User-Agent": "DiscordBot/1.0" } });
        const data = await res.json();
        if (!Array.isArray(data?.tag)) return [];
        return data.tag.map(t => t.name);
    } catch { return []; }
}

const MAX_FILE_SIZE = 7 * 1024 * 1024; // 7MB — margem de segurança abaixo do limite do Discord

async function buildImageMessage(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return null;

    const attachments = [];
    const embeds      = [];

    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Referer":    "https://gelbooru.com/",
                }
            });

            if (!res.ok) {
                console.log(`[download] Falhou ${res.status}: ${url}`);
                continue;
            }

            // Checa tamanho antes de baixar tudo
            const contentLength = parseInt(res.headers.get("content-length") || "0");
            if (contentLength > MAX_FILE_SIZE) {
                console.log(`[download] Arquivo grande demais (${(contentLength/1024/1024).toFixed(1)}MB), pulando`);
                continue;
            }

            const buffer = Buffer.from(await res.arrayBuffer());

            if (buffer.length > MAX_FILE_SIZE) {
                console.log(`[download] Buffer grande demais (${(buffer.length/1024/1024).toFixed(1)}MB), pulando`);
                continue;
            }

            const ext      = url.split(".").pop().split("?")[0] || "jpg";
            const fileName = `image_${i}.${ext}`;

            attachments.push(new AttachmentBuilder(buffer, { name: fileName }));
            embeds.push(new EmbedBuilder().setImage(`attachment://${fileName}`).setColor(0xFF6699));

        } catch (err) {
            console.log(`[download] Erro: ${err.message}`);
        }
    }

    if (attachments.length === 0) return null;
    return { attachments, embeds };
}
// ==================== TAG DO DIA ====================
const TAG_POOL_FILE = "tag_pool.json";
const DAY_TAG_FILE  = "day_tag.json";
const MIN_POST_COUNT = 1000;

const TAG_BLACKLIST = new Set([
    // Meta / qualidade
    "tagme", "uncensored", "censored", "jpeg_artifacts", "absurdres",
    "highres", "lowres", "bad_anatomy", "bad_hands", "bad_proportions",
    "comic", "doujinshi", "4koma", "translated", "english_text",
    "watermark", "signature", "artist_name", "patreon_username",
    "multiple_views", "reference_sheet", "character_sheet",
    "ai-generated", "ai-assisted",
    "rating:g", "rating:s", "rating:q", "rating:e",
    // Conteudo indesejado
    "gaping_anus", "object_insertion", "gel_banana", "food_insertion",
    "no_humans", "real_life", "worm", "parasite", "infested_breasts",
    "violence", "dead", "fart", "huge_ass", "yaoi",
    "anal_beads", "male_focus", "bdsm",
]);

let TAG_POOL = [];

function getTodayKey() {
    const brt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    return `${brt.getFullYear()}-${brt.getMonth() + 1}-${brt.getDate()}`;
}

function getDailyTag() {
    let data = {};
    if (fs.existsSync(DAY_TAG_FILE)) {
        try { data = JSON.parse(fs.readFileSync(DAY_TAG_FILE, "utf8")); } catch {}
    }
    const todayKey = getTodayKey();
    if (data.date === todayKey && data.tag) return data.tag;

    let newTag;
    do {
        newTag = TAG_POOL[Math.floor(Math.random() * TAG_POOL.length)];
    } while (newTag === data.tag && TAG_POOL.length > 1);

    fs.writeFileSync(DAY_TAG_FILE, JSON.stringify({ date: todayKey, tag: newTag }, null, 2));
    console.log(`🏷️ Tag do dia: ${newTag}`);
    return newTag;
}

async function fetchAndCacheTagPool() {
    if (fs.existsSync(TAG_POOL_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TAG_POOL_FILE, "utf8"));
            if (cached.date === getTodayKey() && Array.isArray(cached.tags) && cached.tags.length > 0) {
                TAG_POOL = cached.tags;
                console.log(`🏷️ Pool de tags do cache (Gelbooru): ${TAG_POOL.length} tags`);
                return;
            }
        } catch {}
    }

    console.log("🔄 Buscando tags do Gelbooru (1000+ posts)...");
    const allTags = [];

    try {
        for (let pid = 0; pid < 20; pid++) {
            const params = new URLSearchParams({
                page:    "dapi",
                s:       "tag",
                q:       "index",
                json:    "1",
                api_key: GELBOORU_API_KEY,
                user_id: GELBOORU_USER_ID,
                orderby: "count",
                limit:   100,
                pid,
            });
            const res = await fetch(`https://gelbooru.com/index.php?${params}`, {
                headers: { "User-Agent": "DiscordBot/1.0" }
            });
            if (!res.ok) break;

            const data = await res.json();
            const tags = data?.tag;
            if (!Array.isArray(tags) || tags.length === 0) break;

            for (const tag of tags) {
                if (
                    tag.count >= MIN_POST_COUNT &&
                    tag.name &&
                    tag.type === 0 &&   // 0 = general tags
                    !TAG_BLACKLIST.has(tag.name) &&
                    !tag.name.startsWith("rating:") &&
                    !tag.name.match(/^\d+$/)
                ) {
                    allTags.push(tag.name);
                }
            }

            const lastCount = tags[tags.length - 1]?.count ?? 0;
            if (lastCount < MIN_POST_COUNT) break;

            await new Promise(r => setTimeout(r, 300));
        }
    } catch (err) {
        console.error("Erro ao buscar tags:", err);
    }

    if (allTags.length === 0) {
        console.warn("⚠️ Usando fallback de tags embutido");
        TAG_POOL = [
            "blue_hair", "blonde_hair", "red_hair", "black_hair", "white_hair",
            "pink_hair", "long_hair", "short_hair", "twintails", "ponytail",
            "animal_ears", "wings", "school_uniform", "kimono", "maid",
            "dress", "swimsuit", "thighhighs", "sword", "smile",
            "touhou", "kantai_collection", "azur_lane", "vocaloid", "hatsune_miku",
            "night", "rain", "snow", "flowers", "ocean",
        ];
    } else {
        TAG_POOL = allTags;
        fs.writeFileSync(TAG_POOL_FILE, JSON.stringify({ date: getTodayKey(), tags: TAG_POOL }, null, 2));
        console.log(`✅ Pool atualizado (Gelbooru): ${TAG_POOL.length} tags com ${MIN_POST_COUNT}+ posts`);
    }
}

// ==================== ENVIO AUTOMÁTICO ====================
async function sendImages() {
    const channel = await client.channels.fetch(config.channelId);

    const dailyTag  = getDailyTag();
    const extraTags = config.tags?.trim() || "";

    // Separa tags negativas (ex: -nipples) das positivas
    // Tags negativas tem prioridade e ficam em todas as tentativas
    const tagList     = extraTags.split(/\s+/).filter(Boolean);
    const negativeTags = tagList.filter(t => t.startsWith("-")).join(" ");
    const positiveTags = tagList.filter(t => !t.startsWith("-")).join(" ");

    const withExtras  = [dailyTag, positiveTags, negativeTags].filter(Boolean).join(" ");
    const withNeg     = [dailyTag, negativeTags].filter(Boolean).join(" ");

    const minScore = config.minScore || ">100";

    // Tentativa 1: tag do dia + extras positivas + negativas + score
    let result = await getImages(withExtras, config.rating, config.imagesPerPost, minScore);

    // Tentativa 2: tag do dia + negativas + score (descarta positivas)
    if (result.error) {
        console.log("[sendImages] Tentativa 2: tag do dia + tags negativas + score");
        result = await getImages(withNeg, config.rating, config.imagesPerPost, minScore);
    }

    // Tentativa 3: tag do dia + negativas sem score
    if (result.error) {
        console.log("[sendImages] Tentativa 3: tag do dia + tags negativas sem score");
        result = await getImages(withNeg, config.rating, config.imagesPerPost, null);
    }

    if (result.error) {
        let msg = result.error;
        if (result.suggestions?.length > 0)
            msg += `\n🔎 Você quis dizer: ${result.suggestions.map(t => `\`${t}\``).join(", ")} ?`;
        return channel.send(msg);
    }

    if (!result.images?.length) return channel.send("❌ Nenhuma imagem encontrada.");

    const built = await buildImageMessage(result.images);
    if (!built) return channel.send("❌ Não consegui montar a mensagem.");

    await channel.send({
        content: `🏷️ Tag do dia: \`${dailyTag}\``,
        embeds: built.embeds,
        files:  built.attachments,
    });
}

// ==================== AGENDAMENTO ====================
let hourlyJob = null;

async function scheduleMessages() {
    if (hourlyJob) { hourlyJob.cancel(); hourlyJob = null; }

    await fetchAndCacheTagPool();

    sendImages().catch(err => console.error("[sendImages] Erro inicial:", err));

    hourlyJob = schedule.scheduleJob("0 * * * *", () => {
        fetchAndCacheTagPool().then(() => {
            sendImages().catch(err => console.error("[sendImages] Erro horário:", err));
        });
    });

    console.log("📅 Envio automático: a cada 1 hora");
}

// ==================== COMANDOS ====================
const commands = [
    new SlashCommandBuilder()
        .setName("settags")
        .setDescription("Tags extras combinadas com a tag do dia (ex: -nipples)")
        .addStringOption(o => o.setName("tags").setDescription("Tags do Gelbooru").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setrating")
        .setDescription("Define o rating dos posts automáticos")
        .addStringOption(o =>
            o.setName("rating").setDescription("Nível do conteúdo").setRequired(true)
            .addChoices(
                { name: "General (seguro)",       value: "general"      },
                { name: "Sensitive (levemente)",  value: "sensitive"    },
                { name: "Questionable",           value: "questionable" },
                { name: "Explicit",               value: "explicit"     },
            )
        ),

    new SlashCommandBuilder()
        .setName("setimages")
        .setDescription("Número de imagens por post (máx 10)")
        .addIntegerOption(o => o.setName("quantidade").setDescription("1–10").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Define o canal de envio automático")
        .addChannelOption(o => o.setName("canal").setDescription("Canal").setRequired(true)),

    new SlashCommandBuilder()
        .setName("testpost")
        .setDescription("Força o envio imediato"),

    new SlashCommandBuilder()
        .setName("tagdodia")
        .setDescription("Mostra a tag do dia"),

    new SlashCommandBuilder()
        .setName("pesquisar")
        .setDescription("Pesquisar imagens no Gelbooru")
        .addStringOption(o => o.setName("tags").setDescription("Tags do Gelbooru (ex: blue_hair smile)").setRequired(true))
        .addStringOption(o =>
            o.setName("rating").setDescription("Nível do conteúdo").setRequired(false)
            .addChoices(
                { name: "General",      value: "general"      },
                { name: "Sensitive",    value: "sensitive"    },
                { name: "Questionable", value: "questionable" },
                { name: "Explicit",     value: "explicit"     },
            )
        )
        .addIntegerOption(o => o.setName("quantidade").setDescription("Quantas imagens (máx 10)").setRequired(false))
        .addStringOption(o => o.setName("score").setDescription("Filtro de score (ex: >50)").setRequired(false)),
];

// ==================== BOT ====================
client.once("ready", async () => {
    console.log(`✅ Bot logado como ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
        console.log("📌 Slash commands registrados!");
    } catch (error) {
        console.error(error);
    }
    scheduleMessages();
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        switch (interaction.commandName) {

            case "pesquisar": {
                await interaction.deferReply();
                const tags      = interaction.options.getString("tags");
                const quantidade = Math.min(interaction.options.getInteger("quantidade") || 1, 10);
                const rating    = interaction.options.getString("rating") || config.rating || "sensitive";
                const scoreExpr = interaction.options.getString("score") || null;

                const result = await getImages(tags, rating, quantidade, scoreExpr);

                if (result.error) {
                    let msg = result.error;
                    if (result.suggestions?.length > 0)
                        msg += `\n🔎 Você quis dizer: ${result.suggestions.map(t => `\`${t}\``).join(", ")} ?`;
                    return interaction.editReply(msg);
                }

                const built = await buildImageMessage(result.images);
                if (!built) return interaction.editReply("❌ Não consegui carregar as imagens.");

                await interaction.editReply({
                    content: `🎨 \`${tags}\` — rating: ${rating}`,
                    embeds: built.embeds,
                    files:  built.attachments,
                });
                break;
            }

            case "tagdodia": {
                await interaction.reply(`🏷️ A tag de hoje é: \`${getDailyTag()}\``);
                break;
            }

            case "settags": {
                config.tags = interaction.options.getString("tags");
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Tags extras: \`${config.tags}\``);
                break;
            }

            case "setrating": {
                config.rating = interaction.options.getString("rating");
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Rating: \`${config.rating}\``);
                break;
            }

            case "setimages": {
                config.imagesPerPost = Math.min(interaction.options.getInteger("quantidade"), 10);
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Imagens por post: \`${config.imagesPerPost}\``);
                break;
            }

            case "setchannel": {
                config.channelId = interaction.options.getChannel("canal").id;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Canal: <#${config.channelId}>`);
                break;
            }

            case "testpost": {
                await interaction.reply("📤 Enviando post de teste...");
                await sendImages();
                break;
            }
        }
    } catch (err) {
        console.error("Erro em interactionCreate:", err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply("⚠️ Erro ao executar este comando.");
        } else if (interaction.deferred && !interaction.replied) {
            await interaction.editReply("⚠️ Erro ao executar este comando.");
        }
    }
});

client.login(DISCORD_TOKEN);
