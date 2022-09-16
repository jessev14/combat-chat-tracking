const moduleID = 'combat-chat-tracking';
let socket;
let localizationMap = {};
const localize = key => game.i18n.localize(key);


Hooks.once('init', () => {
    // Register module settings
    game.settings.register(moduleID, 'roundEnabled', {
        name: `${moduleID}.settings.roundEnabled.name`,
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(moduleID, 'autoTrackingEnabled', {
        name: `${moduleID}.settings.autoTrackingEnabled.name`,
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(moduleID, 'notificationsEnabled', {
        name: `${moduleID}.settings.notificationsEnabled.name`,
        hint: `${moduleID}.settings.notificationsEnabled.hint`,
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(moduleID, 'whisperTrackersEnabled', {
        name: `${moduleID}.settings.whisperTrackersEnabled.name`,
        hint: `${moduleID}.settings.whisperTrackersEnabled.hint`,
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(moduleID, 'GMmodeEnabled', {
        name: `${moduleID}.settings.GMmodeEnabled.name`,
        hint: `${moduleID}.settings.GMmodeEnabled.hint`,
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    });
});

Hooks.once('ready', () => {
    // Setup localization map to "un-translate" action types
    for (const actionType of ['Action', 'BonusAction', 'Reaction']) {
        localizationMap[localize(`DND5E.${actionType}`)] = actionType;
    }
});

Hooks.once('socketlib.ready', () => {
    socket = socketlib.registerModule(moduleID);

    // Socket handler to allow non-GMs to update tracker chat messages
    socket.register('updateTracker', updateTracker);
    // Socket handler to notify GM users
    socket.register('notifyUsedAction', notifyUsedAction);
});


// Create round alerts and turn trackers when combat is updated
Hooks.on('preUpdateCombat', async (combat, diff, options, userID) => {
    const isRound = foundry.utils.hasProperty(diff, 'round') && game.settings.get(moduleID, 'roundEnabled');
    const isTurn = foundry.utils.hasProperty(diff, 'turn');
    const whisperTrackersEnabled = game.settings.get(moduleID, 'whisperTrackersEnabled');
    const whisper = [];
    if (whisperTrackersEnabled) whisper.push(...game.users.contents.filter(u => u.isGM).map(u => u.id));

    // Create round alert
    if (isRound) {
        ChatMessage.create({
            content: `<h2>Round ${diff.round}</h2>`,
            whisper,
            flags: {
                [moduleID]: {
                    isRound: true
                }
            }
        });
    }

    // Create turn tracker
    if (isTurn) {
        // Create chat message content using HBS template
        const turnNumber = diff.turn;
        const combatant = combat.turns[turnNumber];
        const combatantName = combatant.name;
        const combatantImg = combatant.img;
        const templateData = {
            moduleID,
            combatantName,
            combatantImg
        };
        const content = await renderTemplate(`modules/${moduleID}/templates/turn-alert.hbs`, templateData);

        // If combatant is hidden, whisper to GM users if not already doing so
        if (combatant.hidden && !whisper.length) whisper.push(...game.users.contents.filter(u => u.isGM).map(u => u.id));

        const chatMessage = await ChatMessage.create({
            content,
            whisper,
            flags: {
                [moduleID]: {
                    isTurn: true,
                    combatantID: combatant.id
                }
            }
        });

        // Save the chat message ID as a flag on the combatant for faster referencing later
        await combatant.setFlag(moduleID, 'trackerID', chatMessage.id);
    }
});

// Add eventListeners to turn trackers
Hooks.on('renderChatMessage', (message, [html], messageData) => {
    if (!message.getFlag(moduleID, 'isRound') && !message.getFlag(moduleID, 'isTurn')) return;

    html.querySelector('header').style.display = 'none';

    if (message.getFlag(moduleID, 'isTurn')) {
        html.querySelectorAll('input').forEach(i => {
            const actionType = i.dataset.action;
            const checked = message.getFlag(moduleID, 'checks')?.[actionType];
            i.checked = checked;

            const GMmodeEnabled = game.settings.get(moduleID, 'GMmodeEnabled');
            const combatant = game.combat.combatants.get(message.getFlag(moduleID, 'combatantID'));
            const canUpdate = game.user.isGM || (GMmodeEnabled ? false : combatant?.isOwner);

            // If current user is allowed to update this tracker, add eventListener that updates the tracker when the checkbox is changed
            if (canUpdate) {
                i.addEventListener('change', ev => {
                    return socket.executeAsGM('updateTracker', message.id, actionType, !checked);
                });
            } else i.parentElement.style['pointer-events'] = 'none';
        });
    };
});

// When a new chat message is created, check to see if it is an action to be tracked
Hooks.on('preCreateChatMessage', (message, messageData, options, userID) => {
    if (!game.settings.get(moduleID, 'autoTrackingEnabled')) return;

    Hooks.once('renderChatMessage', (message, [html], messageData) => {
        // Action type text lives in chat card footer
        const footer = html.querySelector('footer.card-footer');
        if (!footer) return;
        
        // Use RegExp to search the footer text for 'Action', 'Bonus Action', or 'Reaction' to discern the action type
        const actionRE = new RegExp(`${localize('DND5E.Action')}|${localize('DND5E.BonusAction')}|${localize('DND5E.Reaction')}`);
        const searchRes = actionRE.exec(footer.textContent);
        const localizedType = searchRes[0];
        const type = localizationMap[localizedType];
        if (!type) return;

        // Find the combatant based on the chat message's token speaker
        const token = fromUuidSync(`Scene.${message.speaker.scene}.Token.${message.speaker.token}`);
        const { combatant } = token;
        if (!combatant) return;

        // Get the target turn tracker based on the combatant
        const targetTracker = game.messages.get(combatant.getFlag(moduleID, 'trackerID'));
        if (!targetTracker) return;

        // If notifications enabled, check current state of action on tracker
        if (game.settings.get(moduleID, 'notificationsEnabled')) {
            const actionState = targetTracker.getFlag(moduleID, `checks.${type}`);
            if (actionState) socket.executeAsGM('notifyUsedAction', combatant.name, localizedType);
        }

        // Update the tracker
        return socket.executeAsGM('updateTracker', targetTracker.id, type, true);
    });
});


// Socket handler to update tracker chat messages based on the messageID, action type, and track state
function updateTracker(trackerID, actionType, checked) {
    game.messages.get(trackerID).setFlag(moduleID, `checks.${actionType}`, checked);
}

// Socket handler to notify GM users when a character uses an action type they've already used (based on latest tracker)
function notifyUsedAction(combatantName, actionType) {
    const notificationContent = game.i18n.format(`${moduleID}.notification`, { combatantName, actionType });
    ui.notifications.warn(notificationContent);
}
