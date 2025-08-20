const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const schedule = require('node-schedule');
const fs = require('fs');

// fetch global
const fetch = globalThis.fetch;

// Config Inicial
let config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// FUNÇÕES
// Buscar imagens no Gelbooru
async function getImages(tags = "", rating = "general", limit = 1) {
    let baseUrl = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1";

    if (config.api_key && config.user_id) {
        baseUrl += `&api_key=${config.api_key}&user_id=${config.user_id}`;
    }

    const url = `${baseUrl}&tags=${encodeURIComponent(tags + " rating:" + rating)}&limit=100`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        const posts = Array.isArray(data) ? data : (data.post || []);
        if (!posts || posts.length === 0) {
            const suggestions = await getTagSuggestions(tags);
            return { error: `❌ Nenhuma imagem encontrada para **${tags}** com rating **${rating}**.`, suggestions };
        }

        const validImages = posts.filter(img => {
            const url = img?.file_url || img?.sample_url || img?.preview_url;
            return url && url.match(/\.(jpg|jpeg|png|gif)$/i);
        });

        if (validImages.length === 0) {
            return { error: "❌ Não foi possível carregar nenhuma imagem válida." };
        }

        const results = [];
        for (let i = 0; i < limit; i++) {
            const img = validImages[Math.floor(Math.random() * validImages.length)];
            const url = img.file_url || img.sample_url || img.preview_url;
            if (url) results.push(url);
        }

        return { images: results };
    } catch (err) {
        console.error("Erro ao buscar imagens:", err);
        return { error: "⚠️ Ocorreu um erro ao buscar imagens." };
    }
}

// Buscar sugestões de tags parecidas
async function getTagSuggestions(tag) {
    const url = `https://gelbooru.com/index.php?page=dapi&s=tag&q=index&json=1&limit=5&name_pattern=${encodeURIComponent(tag)}*`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (!data || data.length === 0) return [];
        return data.map(t => t.name);
    } catch (err) {
        console.error("Erro ao buscar sugestões de tags:", err);
        return [];
    }
}

// Enviar imagens automáticas (config global)
async function sendImages() {
    const channel = await client.channels.fetch(config.channelId);
    const result = await getImages(config.tags, config.rating, config.imagesPerPost);

    if (result.error) {
        let msg = result.error;
        if (result.suggestions && result.suggestions.length > 0) {
            msg += `\n🔎 Você quis dizer: ${result.suggestions.map(t => `\`${t}\``).join(", ")} ?`;
        }
        await channel.send(msg);
    } else {
        if (result.images.length === 0) {
            await channel.send("❌ Não foi possível carregar nenhuma imagem.");
        } else {
            await channel.send({
                content: `🎨 Aqui estão suas imagens (${config.tags || "sem tags"})`,
                files: result.images.map((url, i) => ({
                    attachment: url,
                    name: `image_${i}.jpg`
                }))
            });
        }
    }
}

// AGENDAMENTO
let currentJobs = [];
function scheduleMessages() {
    currentJobs.forEach(job => job.cancel());
    currentJobs = [];

    const timesPerDay = config.timesPerDay || 1;
    const frequency = config.frequency || "daily";

    if (frequency === "daily") {
        for (let i = 0; i < timesPerDay; i++) {
            let job;
            if (config.fixedHour !== null && config.fixedMinute !== null) {
                job = schedule.scheduleJob({ hour: config.fixedHour, minute: config.fixedMinute, tz: "America/Sao_Paulo" }, sendImages);
            } else {
                const hour = Math.floor(Math.random() * 15) + 8;
                const minute = Math.floor(Math.random() * 60);
                job = schedule.scheduleJob({ hour, minute, tz: "America/Sao_Paulo" }, sendImages);
            }
            currentJobs.push(job);
        }
    }
}

// COMANDOS
const commands = [
    new SlashCommandBuilder()
        .setName("settags")
        .setDescription("Define as tags de busca (config global)")
        .addStringOption(option =>
            option.setName("tags").setDescription("Ex: naruto, goku").setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("setrating")
        .setDescription("Define o rating (config global)")
        .addStringOption(option =>
            option.setName("rating").setDescription("general, sensitive, questionable, explicit")
            .setRequired(true)
            .addChoices(
                { name: "General", value: "general" },
                { name: "Sensitive", value: "sensitive" },
                { name: "Questionable", value: "questionable" },
                { name: "Explicit", value: "explicit" }
            )
        ),

    new SlashCommandBuilder()
        .setName("setfrequency")
        .setDescription("Frequência de envio (config global)")
        .addStringOption(option =>
            option.setName("tipo").setDescription("daily ou weekly").setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName("vezes").setDescription("Quantas vezes").setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("setimages")
        .setDescription("Número de imagens por post (config global)")
        .addIntegerOption(option =>
            option.setName("quantidade").setDescription("Número").setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("settime")
        .setDescription("Horário fixo ou aleatório (config global)")
        .addStringOption(option =>
            option.setName("horario").setDescription("HH:MM ou off").setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Define o canal (config global)")
        .addChannelOption(option =>
            option.setName("canal").setDescription("Escolha o canal").setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("testpost")
        .setDescription("Força o envio imediato (config global)"),

    new SlashCommandBuilder()
        .setName("pesquisar")
        .setDescription("Pesquisar imagens personalizadas (multiusuário)")
        .addStringOption(option =>
            option.setName("tags").setDescription("Tags de busca").setRequired(true)
        )
        .addStringOption(option =>
            option.setName("rating")
            .setDescription("general, sensitive, questionable, explicit")
            .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName("quantidade")
            .setDescription("Quantas imagens (padrão 1)").setRequired(false)
        )
];

// BOT
client.once("ready", async () => {
    console.log(`✅ Bot logado como ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(config.token);

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

                const tags = interaction.options.getString("tags") || "";
                const formattedTags = tags.split(",").map(t => t.trim()).join(" ");
                const ratingInput = interaction.options.getString("rating");
                const qtd = interaction.options.getInteger("quantidade") || 1;

                // Se rating não for informado → escolhe um aleatório
                const ratings = ["general", "sensitive", "questionable", "explicit"];
                const rating = ratingInput || ratings[Math.floor(Math.random() * ratings.length)];

                const result = await getImages(tags, rating, qtd);

                if (result.error) {
                    let msg = result.error;
                    if (result.suggestions?.length > 0) {
                        msg += `\n🔎 Sugestões: ${result.suggestions.map(t => `\`${t}\``).join(", ")}`;
                    }
                    await interaction.editReply(msg);
                } else {
                    const files = result.images.map((url, i) => {
                        if (rating === "explicit" && !interaction.channel.nsfw) {
                            return {
                                attachment: url,
                                name: `SPOILER_pesquisa_${i}.jpg`
                            };
                        } else {
                            return {
                                attachment: url,
                                name: `pesquisa_${i}.jpg`
                            };
                        }
                    });

                    await interaction.editReply({
                        content: `🎨 Resultados da pesquisa: \`${tags}\` (rating: ${rating})`,
                        files
                    });
                }
                break;
            }

            case "settags": {
                const tags = interaction.options.getString("tags");
                config.tags = tags;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Tags atualizadas para: \`${tags}\``);
                break;
            }

            case "setrating": {
                const rating = interaction.options.getString("rating");
                config.rating = rating;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Rating atualizado para: \`${rating}\``);
                break;
            }

            case "setchannel": {
                const channel = interaction.options.getChannel("canal");
                if (!channel || channel.type !== 0) {
                    return interaction.reply("❌ Escolha um canal de texto válido.");
                }
                config.channelId = channel.id;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                scheduleMessages();
                await interaction.reply(`✅ Canal atualizado para: ${channel.name}`);
                break;
            }

            case "setfrequency": {
                const tipo = interaction.options.getString("tipo");
                config.frequency = tipo;
                config.timesPerDay = interaction.options.getInteger("vezes") || 1;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                scheduleMessages();
                await interaction.reply(`✅ Frequência: ${config.timesPerDay}x por ${config.frequency}`);
                break;
            }

            case "setimages": {
                const qtd = interaction.options.getInteger("quantidade");
                config.imagesPerPost = qtd;
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                await interaction.reply(`✅ Imagens por post: \`${qtd}\``);
                break;
            }

            case "settime": {
                const horario = interaction.options.getString("horario");
                if (horario.toLowerCase() === "off") {
                    config.fixedHour = null;
                    config.fixedMinute = null;
                    await interaction.reply("✅ Horário fixo removido (aleatório).");
                } else {
                    const [hour, minute] = horario.split(":").map(n => parseInt(n));
                    if (isNaN(hour) || isNaN(minute)) {
                        return interaction.reply("❌ Formato inválido. Use HH:MM (24h).");
                    }
                    config.fixedHour = hour;
                    config.fixedMinute = minute;
                    await interaction.reply(`✅ Horário fixo definido para ${hour}:${minute.toString().padStart(2, "0")}`);
                }
                fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
                scheduleMessages();
                break;
            }

            case "testpost": {
                await interaction.deferReply({ ephemeral: true });
                await sendImages();
                await interaction.editReply("📤 Imagens de teste enviadas!");
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

client.login(config.token);
