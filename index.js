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
const RULE34_USER_ID    = process.env.RULE34_USER_ID;
const RULE34_API_KEY    = process.env.RULE34_API_KEY;

if (!DISCORD_TOKEN || !GELBOORU_API_KEY || !GELBOORU_USER_ID) {
    console.error("❌ Credenciais faltando no .env! Verifique DISCORD_TOKEN, GELBOORU_API_KEY e GELBOORU_USER_ID.");
    process.exit(1);
}
if (!RULE34_USER_ID || !RULE34_API_KEY) {
    console.warn("⚠️ RULE34_USER_ID ou RULE34_API_KEY não definidos — fallback Rule34 desativado.");
}

// Dono do bot — único que pode usar comandos restritos
const OWNER_ID = "115936058943864836";

// Configurações do bot — ficam no config.json (pode compartilhar)
let config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

// ==================== GELBOORU + RULE34 ====================

function toGelbooruRating(rating) {
    const map = { general: "general", safe: "general", sensitive: "sensitive", questionable: "questionable", explicit: "explicit" };
    return map[rating] || "sensitive";
}

function toRule34Rating(rating) {
    // Rule34 usa rating como tag: rating:general, rating:questionable etc
    const map = { general: "rating:general", safe: "rating:general", sensitive: "rating:questionable", questionable: "rating:questionable", explicit: "rating:explicit" };
    return map[rating] || "rating:questionable";
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

// ── Gelbooru ──────────────────────────────────────────────────
async function getImagesGelbooru(tags, rating, limit, scoreExpr) {
    const ratingTag = `rating:${toGelbooruRating(rating)}`;
    const noVideo   = "-webm -mp4 -animated_gif -video";
    const finalTags = [tags?.trim(), ratingTag, scoreExpr ? `score:${scoreExpr}` : "", noVideo]
        .filter(Boolean).join(" ").trim();

    const pid    = Math.floor(Math.random() * 50);
    const params = gelbooruParams({ tags: finalTags, limit: 100, pid });

    const res = await fetch(`https://gelbooru.com/index.php?${params}`, {
        headers: { "User-Agent": "DiscordBot/1.0" },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Gelbooru HTTP ${res.status}`);

    const data  = await res.json();
    let posts = data?.post;

    if (!Array.isArray(posts) || posts.length === 0) {
        if (pid > 0) {
            const params2 = gelbooruParams({ tags: finalTags, limit: 100, pid: 0 });
            const res2 = await fetch(`https://gelbooru.com/index.php?${params2}`, {
                headers: { "User-Agent": "DiscordBot/1.0" },
                signal: AbortSignal.timeout(8000),
            });
            if (res2.ok) {
                const data2 = await res2.json();
                posts = data2?.post;
            }
        }
    }

    if (!Array.isArray(posts) || posts.length === 0) return null;

    const valid = posts.filter(p =>
        p.file_url &&
        ["jpg", "jpeg", "png", "gif", "webp"].includes(p.image?.split(".").pop()?.toLowerCase() || "")
    );
    if (valid.length === 0) return null;

    const chosen = valid.sort(() => Math.random() - 0.5).slice(0, Math.min(limit, valid.length));
    console.log(`[Gelbooru] ${chosen.length} imagens — ${finalTags}`);
    return chosen.map(p => p.file_url);
}

// ── Rule34 (fallback) ─────────────────────────────────────────
async function getImagesRule34(tags, rating, limit, scoreExpr) {
    const ratingTag = toRule34Rating(rating);
    const noVideo   = "-webm -mp4 -animated_gif";
    const score     = scoreExpr ? `score:${scoreExpr}` : "score:>50";
    const finalTags = [tags?.trim(), ratingTag, score, noVideo]
        .filter(Boolean).join(" ").trim();

    const pid    = Math.floor(Math.random() * 20);
    const params = new URLSearchParams({
        page:    "dapi",
        s:       "post",
        q:       "index",
        json:    "1",
        limit:   100,
        pid,
        tags:    finalTags,
        user_id: RULE34_USER_ID,
        api_key: RULE34_API_KEY,
    });

    const res = await fetch(`https://api.rule34.xxx/index.php?${params}`, {
        headers: { "User-Agent": "DiscordBot/1.0" },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Rule34 HTTP ${res.status}`);

    const posts = await res.json();
    if (!Array.isArray(posts) || posts.length === 0) return null;

    const valid = posts.filter(p =>
        p.file_url &&
        ["jpg", "jpeg", "png", "gif", "webp"].includes(p.file_url.split(".").pop()?.split("?")[0]?.toLowerCase() || "")
    );
    if (valid.length === 0) return null;

    const chosen = valid.sort(() => Math.random() - 0.5).slice(0, Math.min(limit, valid.length));
    console.log(`[Rule34] ${chosen.length} imagens — ${finalTags}`);
    return chosen.map(p => p.file_url);
}

// ── Dispatcher: tenta Gelbooru, cai no Rule34 se falhar ───────
async function getImages(tags = "", rating = "sensitive", limit = 1, scoreExpr = null) {
    // Tenta Gelbooru primeiro
    try {
        const urls = await getImagesGelbooru(tags, rating, limit, scoreExpr);
        if (urls && urls.length > 0) return { images: urls };
    } catch (err) {
        console.warn(`[Gelbooru] falhou (${err.message}) — tentando Rule34`);
    }

    // Fallback: Rule34
    try {
        const urls = await getImagesRule34(tags, rating, limit, scoreExpr);
        if (urls && urls.length > 0) return { images: urls };
    } catch (err) {
        console.error(`[Rule34] falhou: ${err.message}`);
    }

    return { error: "❌ Nenhuma imagem encontrada (Gelbooru e Rule34 falharam)." };
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
        const res = await fetch(`https://gelbooru.com/index.php?${params}`, {
            headers: { "User-Agent": "DiscordBot/1.0" },
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        if (!Array.isArray(data?.tag)) return [];
        return data.tag.map(t => t.name);
    } catch { return []; }
}

const MAX_FILE_SIZE = 7 * 1024 * 1024; // 7MB — margem de segurança abaixo do limite do Discord

async function downloadImage(url) {
    const referer = url.includes("rule34") ? "https://rule34.xxx/" : "https://gelbooru.com/";

    const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": referer },
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentLength = parseInt(res.headers.get("content-length") || "0");
    if (contentLength > MAX_FILE_SIZE) throw new Error(`grande demais (${(contentLength/1024/1024).toFixed(1)}MB)`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) throw new Error(`buffer grande demais (${(buffer.length/1024/1024).toFixed(1)}MB)`);

    return buffer;
}

async function buildImageMessage(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return null;

    const attachments = [];
    const embeds      = [];

    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        try {
            const buffer   = await downloadImage(url);
            const ext      = url.split(".").pop().split("?")[0] || "jpg";
            const fileName = `image_${i}.${ext}`;
            attachments.push(new AttachmentBuilder(buffer, { name: fileName }));
            embeds.push(new EmbedBuilder().setImage(`attachment://${fileName}`).setColor(0xFF6699));
            console.log(`[download] ✓ image_${i}.${ext}`);
        } catch (err) {
            console.log(`[download] Falhou (${err.message}) — usando embed direto`);
            // Fallback: manda URL direto no embed (funciona se o Discord conseguir carregar)
            embeds.push(new EmbedBuilder().setImage(url).setColor(0xFF6699));
        }
    }

    // Se tiver attachments, usa eles; senão manda só os embeds com URL direta
    if (attachments.length > 0) {
        return { attachments, embeds: embeds.slice(0, attachments.length) };
    }
    // Embeds com URL direta (sem attachment)
    return { attachments: [], embeds };
}
// ==================== TAG DO DIA ====================
const TAG_POOL_FILE       = "tag_pool.json";
const COPYRIGHT_POOL_FILE = "copyright_pool.json";
const DAY_TAG_FILE        = "day_tag.json";
const MIN_POST_COUNT      = 1000;

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

// Tags de copyright (series) a ignorar
const COPYRIGHT_BLACKLIST = new Set([
    "original", "original_character",
]);

let TAG_POOL       = [];
let COPYRIGHT_POOL = [];

function getTodayKey() {
    const brt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    return `${brt.getFullYear()}-${brt.getMonth() + 1}-${brt.getDate()}`;
}

function isOddDay() {
    const brt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    return brt.getDate() % 2 !== 0;
}

function getActivePool() {
    return isOddDay() ? COPYRIGHT_POOL : TAG_POOL;
}

function getDailyTag() {
    let data = {};
    if (fs.existsSync(DAY_TAG_FILE)) {
        try { data = JSON.parse(fs.readFileSync(DAY_TAG_FILE, "utf8")); } catch {}
    }
    const todayKey = getTodayKey();
    if (data.date === todayKey && data.tag) return data.tag;

    const pool = getActivePool();
    let newTag;
    do {
        newTag = pool[Math.floor(Math.random() * pool.length)];
    } while (newTag === data.tag && pool.length > 1);

    const poolType = isOddDay() ? "copyright" : "general";
    fs.writeFileSync(DAY_TAG_FILE, JSON.stringify({ date: todayKey, tag: newTag, pool: poolType }, null, 2));
    console.log(`🏷️ Tag do dia (${poolType}): ${newTag}`);
    return newTag;
}

async function fetchTagsByType(type, typeLabel, blacklist) {
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
                type,
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
                    !blacklist.has(tag.name) &&
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
        console.error(`Erro ao buscar tags (${typeLabel}):`, err);
    }
    return allTags;
}

async function fetchAndCacheTagPool() {
    const todayKey = getTodayKey();

    // Pool geral (type 0)
    if (fs.existsSync(TAG_POOL_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TAG_POOL_FILE, "utf8"));
            if (cached.date === todayKey && Array.isArray(cached.tags) && cached.tags.length > 0) {
                TAG_POOL = cached.tags;
                console.log(`🏷️ Pool geral do cache: ${TAG_POOL.length} tags`);
            }
        } catch {}
    }
    if (TAG_POOL.length === 0) {
        console.log("🔄 Buscando tags gerais do Gelbooru...");
        const tags = await fetchTagsByType(0, "general", TAG_BLACKLIST);
        if (tags.length > 0) {
            TAG_POOL = tags;
            fs.writeFileSync(TAG_POOL_FILE, JSON.stringify({ date: todayKey, tags: TAG_POOL }, null, 2));
            console.log(`✅ Pool geral: ${TAG_POOL.length} tags`);
        } else {
            console.warn("⚠️ Fallback pool geral");
            TAG_POOL = ["blue_hair", "blonde_hair", "red_hair", "black_hair", "white_hair",
                "long_hair", "short_hair", "twintails", "animal_ears", "school_uniform",
                "dress", "swimsuit", "thighhighs", "smile", "flowers"];
        }
    }

    // Pool copyright/series — dias impares
    // Carregada do arquivo copyright_pool_default.json
    if (COPYRIGHT_POOL.length === 0) {
        try {
            const raw = JSON.parse(fs.readFileSync("copyright_pool_default.json", "utf8"));
            COPYRIGHT_POOL = raw.filter(t => !COPYRIGHT_BLACKLIST.has(t));
            console.log(`🎌 Pool copyright carregada: ${COPYRIGHT_POOL.length} series`);
        } catch (err) {
            console.warn("⚠️ copyright_pool_default.json não encontrado — usando fallback");
            COPYRIGHT_POOL = [
                "touhou", "kantai_collection", "blue_archive", "arknights",
                "genshin_impact", "hololive", "nijisanji", "vocaloid",
                "azur_lane", "fate_(series)", "pokemon", "idolmaster",
            ];
        }
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
        ...(built.attachments.length > 0 ? { files: built.attachments } : {}),
    });
}

// ==================== AGENDAMENTO ====================
let hourlyJob = null;
let lastDayKey = null;

async function scheduleMessages() {
    if (hourlyJob) { hourlyJob.cancel(); hourlyJob = null; }

    await fetchAndCacheTagPool();
    lastDayKey = getTodayKey();

    sendImages().catch(err => console.error("[sendImages] Erro inicial:", err));

    hourlyJob = schedule.scheduleJob("0 * * * *", () => {
        const todayKey = getTodayKey();

        // Virou o dia — reseta a tag pra pegar a pool correta (par/impar)
        if (todayKey !== lastDayKey) {
            console.log(`\uD83C\uDF05 Novo dia (${todayKey}) — resetando tag do dia`);
            if (fs.existsSync(DAY_TAG_FILE)) fs.unlinkSync(DAY_TAG_FILE);
            lastDayKey = todayKey;
        }

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
        .setName("refreshtag")
        .setDescription("Troca a tag do dia por uma nova aleatória (só o dono do bot)"),

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
                    ...(built.attachments.length > 0 ? { files: built.attachments } : {}),
                });
                break;
            }

            case "refreshtag": {
                if (interaction.user.id !== OWNER_ID) {
                    return interaction.reply({ content: "❌ Só o dono do bot pode usar esse comando.", ephemeral: true });
                }
                // Força nova tag deletando a do dia atual
                if (fs.existsSync(DAY_TAG_FILE)) fs.unlinkSync(DAY_TAG_FILE);
                const newTag  = getDailyTag();
                const poolType = isOddDay() ? "series 🎌" : "geral 🏷️";
                await interaction.reply(`🔄 Tag do dia atualizada para: \`${newTag}\` (pool ${poolType})`);
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
