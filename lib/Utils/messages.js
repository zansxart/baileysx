import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import {} from 'stream';
import { proto } from '../../WAProto/index.js';
import { BIZ_BOT_SUPPORT_PAYLOAD, CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { botMetadataCertificate, botMetadataSignature, prepareAiTextMessage, prepareRichResponseMessage } from './rich-message-utils.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { downloadContentFromMessage, encryptedStream, formatWaveform, generateFallbackWaveform, generateThumbnail, getAudioDuration, getAudioWaveform, getRawMediaUploadData } from './messages-media.js';
import { shouldIncludeReportingToken } from './reporting-utils.js';
const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
};
const MessageTypeProto = {
    image: WAProto.Message.ImageMessage,
    video: WAProto.Message.VideoMessage,
    audio: WAProto.Message.AudioMessage,
    sticker: WAProto.Message.StickerMessage,
    document: WAProto.Message.DocumentMessage
};
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        }
        catch (error) {
            // ignore if fails
            logger?.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    let assertedColor;
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
    }
    else {
        let hex = color.trim().replace('#', '');
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0');
        }
        assertedColor = parseInt(hex, 16);
        return assertedColor;
    }
};
export const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
        }
    }
    if (!mediaType) {
        throw new Boom('Invalid media type', { statusCode: 400 });
    }
    const uploadData = {
        ...message,
        media: message[mediaType]
    };
    delete uploadData[mediaType];
    // check if cacheable + generate cache key
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString();
    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file';
    }
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }
    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            const obj = proto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            Object.assign(obj[key], { ...uploadData, media: undefined });
            return obj;
        }
    }
    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter');
        const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger);
        const fileSha256B64 = fileSha256.toString('base64');
        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        });
        await fs.unlink(filePath);
        const obj = WAProto.Message.fromObject({
            // todo: add more support here
            [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined
            })
        });
        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage;
            delete obj.videoMessage;
        }
        if (obj.stickerMessage) {
            obj.stickerMessage.stickerSentTs = Date.now();
        }
        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
        }
        return obj;
    }
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined';
    const requiresAudioBackground = (options.backgroundColor || uploadData?.backgroundArgb) && mediaType === 'audio' && uploadData.ptt === true;
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation || requiresWaveformProcessing;
    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options
    });
    const fileEncSha256B64 = fileEncSha256.toString('base64');
    const [{ mediaUrl, directPath }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            });
            logger?.debug({ mediaType, cacheableKey }, 'uploaded media');
            return result;
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger?.debug('set dimensions');
                    }
                    logger?.debug('generated thumbnail');
                }
                if (requiresDurationComputation) {
                    uploadData.seconds = await getAudioDuration(originalFilePath);
                    logger?.debug('computed audio duration');
                }
                if (requiresWaveformProcessing) {
                    uploadData.waveform = await getAudioWaveform(originalFilePath, logger);
                    logger?.debug('processed waveform');
                }
                if (uploadData.waveform) {
                    uploadData.waveform = formatWaveform(uploadData.waveform);
                }
                else if (mediaType === 'audio' && uploadData.ptt === true) {
                    uploadData.waveform = generateFallbackWaveform(64);
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor || uploadData?.backgroundArgb);
                    logger?.debug('computed backgroundColor audio status');
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })()
    ]).finally(async () => {
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) {
                await fs.unlink(originalFilePath);
            }
            logger?.debug('removed tmp files');
        }
        catch (error) {
            logger?.warn('failed to remove tmp file');
        }
    });
    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: unixTimestampSeconds(),
            ...uploadData,
            waveform: uploadData.waveform ? new Uint8Array(uploadData.waveform) : undefined,
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
};
export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
    ephemeralExpiration = ephemeralExpiration || 0;
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration
                }
            }
        }
    };
    return WAProto.Message.fromObject(content);
};
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message;
    if (!content) {
        throw new Boom('no content in message', { statusCode: 400 });
    }
    // hacky copy
    content = normalizeMessageContent(content);
    content = proto.Message.decode(proto.Message.encode(content).finish());
    let key = Object.keys(content)[0];
    let score = content?.[key]?.contextInfo?.forwardingScore || 0;
    score += message.key.fromMe && !forceForward ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    const key_ = content?.[key];
    if (score > 0) {
        key_.contextInfo = { forwardingScore: score, isForwarded: true };
    }
    else {
        key_.contextInfo = {};
    }
    return content;
};
export const hasNonNullishProperty = (message, key) => {
    return (typeof message === 'object' &&
        message !== null &&
        key in message &&
        message[key] !== null &&
        message[key] !== undefined);
};
function hasOptionalProperty(obj, key) {
    return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null;
}
/**
 * Converts various button formats (legacy buttons, template buttons, native flow buttons, url/call/copy buttons)
 * into standard WhatsApp Native Flow buttons (quick_reply, cta_url, cta_copy, cta_call).
 */
export const convertButtonToNative = (btn) => {
    if (!btn || typeof btn !== 'object') {
        const text = String(btn || 'Button');
        return {
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: text,
                id: text
            })
        };
    }
    // 1. Already standard native flow format
    if (btn.name && (btn.buttonParamsJson || btn.paramsJson)) {
        return {
            name: btn.name,
            buttonParamsJson: typeof btn.buttonParamsJson === 'string'
                ? btn.buttonParamsJson
                : typeof btn.paramsJson === 'string'
                    ? btn.paramsJson
                    : JSON.stringify(btn.buttonParamsJson || btn.paramsJson || {})
        };
    }
    // 2. Type 4 / nativeFlowInfo format (often used in menu / selection buttons)
    if (btn.nativeFlowInfo) {
        return {
            name: btn.nativeFlowInfo.name || 'quick_reply',
            buttonParamsJson: typeof btn.nativeFlowInfo.paramsJson === 'string'
                ? btn.nativeFlowInfo.paramsJson
                : JSON.stringify(btn.nativeFlowInfo.paramsJson || {})
        };
    }
    // 3. Hydrated template button formats
    if (btn.quickReplyButton) {
        return {
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: btn.quickReplyButton.displayText || 'Button',
                id: btn.quickReplyButton.id || ''
            })
        };
    }
    if (btn.urlButton) {
        const url = btn.urlButton.url || '';
        return {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: btn.urlButton.displayText || 'Visit URL',
                url,
                merchant_url: url
            })
        };
    }
    if (btn.callButton) {
        return {
            name: 'cta_call',
            buttonParamsJson: JSON.stringify({
                display_text: btn.callButton.displayText || 'Call',
                phone_number: btn.callButton.phoneNumber || ''
            })
        };
    }
    // 4. URL / Web button
    if (btn.url || btn.cta_url) {
        const url = btn.url || btn.cta_url;
        const text = btn.text || btn.displayText || btn.buttonText?.displayText || 'Visit URL';
        return {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: text,
                url,
                merchant_url: url
            })
        };
    }
    // 5. Copy code button
    if (btn.copy || btn.copy_code || btn.cta_copy) {
        const code = btn.copy || btn.copy_code || btn.cta_copy;
        const text = btn.text || btn.displayText || btn.buttonText?.displayText || 'Copy';
        return {
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: text,
                id: btn.id || btn.buttonId || 'copy',
                copy_code: code
            })
        };
    }
    // 6. Call button
    if (btn.call || btn.phoneNumber || btn.cta_call) {
        const phone = btn.call || btn.phoneNumber || btn.cta_call;
        const text = btn.text || btn.displayText || btn.buttonText?.displayText || 'Call';
        return {
            name: 'cta_call',
            buttonParamsJson: JSON.stringify({
                display_text: text,
                phone_number: phone
            })
        };
    }
    // 7. Standard Quick Reply / Response button (legacy Baileys format: buttonId, buttonText)
    const id = btn.buttonId || btn.id || '';
    const displayText = btn.buttonText?.displayText || btn.displayText || btn.text || (typeof btn === 'string' ? btn : 'Button');
    return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
            display_text: displayText,
            id
        })
    };
};
/**
 * Sanitizes and prepares an interactiveMessage (nativeFlow, payment buttons, carousel, etc.)
 * into a clean structure that WhatsApp mobile (Android/iOS) and Web can render cleanly without
 * throwing circular reference errors or falling back to "unsupported version".
 */
export const prepareInteractiveMessage = (interactiveContent, options = {}) => {
    if (!interactiveContent || typeof interactiveContent !== 'object') {
        return interactiveContent;
    }
    let unwrappedContext = undefined;
    let targetInteractive = undefined;
    const isAlreadyViewOnce = Boolean(interactiveContent.viewOnceMessage ||
        interactiveContent.viewOnceMessageV2);
    if (interactiveContent.viewOnceMessage?.message?.interactiveMessage) {
        unwrappedContext = interactiveContent.viewOnceMessage.message.messageContextInfo;
        targetInteractive = interactiveContent.viewOnceMessage.message.interactiveMessage;
    }
    else if (interactiveContent.viewOnceMessageV2?.message?.interactiveMessage) {
        unwrappedContext = interactiveContent.viewOnceMessageV2.message.messageContextInfo;
        targetInteractive = interactiveContent.viewOnceMessageV2.message.interactiveMessage;
    }
    else if (interactiveContent.interactiveMessage) {
        unwrappedContext = interactiveContent.messageContextInfo;
        targetInteractive = interactiveContent.interactiveMessage;
    }
    else {
        targetInteractive = interactiveContent;
        unwrappedContext = interactiveContent.messageContextInfo;
    }
    const clean = { ...targetInteractive };
    const garbageKeys = [
        'key',
        'mtype',
        'chat',
        'id',
        'from',
        'isBaileys',
        'sender',
        'fromMe',
        'text',
        'mentionedJid',
        'fakeObj',
        'vM',
        'isGroup',
        'userReceipt',
        'reactions',
        'pollUpdates',
        'eventResponses',
        'statusMentions',
        'messageAddOns',
        'labels',
        'messageStubParameters',
        'statusMentionSources',
        'supportAiCitations'
    ];
    for (const k of garbageKeys) {
        delete clean[k];
    }
    if (clean.header && typeof clean.header.hasMediaAttachment === 'undefined') {
        clean.header = {
            ...clean.header,
            hasMediaAttachment: Boolean(clean.header.imageMessage ||
                clean.header.videoMessage ||
                clean.header.documentMessage)
        };
    }
    if (!clean.body || typeof clean.body.text !== 'string' || clean.body.text.trim() === '') {
        clean.body = {
            text: options.defaultTextFallback || clean.body?.text || ' '
        };
    }
    const contextInfo = {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        ...(unwrappedContext && typeof unwrappedContext === 'object' ? unwrappedContext : {})
    };
    for (const k of garbageKeys) {
        delete contextInfo[k];
    }
    if (Array.isArray(contextInfo.threadId) && contextInfo.threadId.length === 0) {
        delete contextInfo.threadId;
    }
    const shouldWrapViewOnce = options.viewOnce !== false;
    if (shouldWrapViewOnce) {
        return {
            viewOnceMessage: {
                message: {
                    messageContextInfo: contextInfo,
                    interactiveMessage: clean
                }
            }
        };
    }
    return {
        messageContextInfo: contextInfo,
        interactiveMessage: clean
    };
};
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    const anyMsg = message;
    let m = {};
    if (hasNonNullishProperty(message, 'raw')) {
        delete anyMsg.raw;
        return message;
    }
    else if (hasNonNullishProperty(message, 'code') ||
        hasNonNullishProperty(message, 'links') ||
        hasNonNullishProperty(message, 'table') ||
        hasNonNullishProperty(message, 'richResponse') ||
        hasNonNullishProperty(message, 'html')) {
        m = prepareRichResponseMessage(message);
    }
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor);
        }
        else if (message.backgroundArgb) {
            extContent.backgroundArgb = message.backgroundArgb;
        }
        if (options.font) {
            extContent.font = options.font;
        }
        else if (message.font) {
            extContent.font = message.font;
        }
        if (message.title) {
            extContent.title = message.title;
        }
        if (message.jpegThumbnail) {
            extContent.jpegThumbnail = message.jpegThumbnail;
        }
        if (message.inviteLinkParentGroupSubjectV2) {
            extContent.inviteLinkParentGroupSubjectV2 = message.inviteLinkParentGroupSubjectV2;
        }
        if (message.inviteLinkParentGroupThumbnailV2) {
            extContent.inviteLinkParentGroupThumbnailV2 = message.inviteLinkParentGroupThumbnailV2;
        }
        m.extendedTextMessage = extContent;
    }
    else if (hasNonNullishProperty(message, 'contacts')) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0]);
        }
        else {
            m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts);
        }
    }
    else if (hasNonNullishProperty(message, 'location')) {
        m.locationMessage = WAProto.Message.LocationMessage.create(message.location);
    }
    else if (hasNonNullishProperty(message, 'react')) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react);
    }
    else if (hasNonNullishProperty(message, 'delete')) {
        m.protocolMessage = {
            key: message.delete,
            type: WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    }
    else if (hasNonNullishProperty(message, 'forward')) {
        m = generateForwardMessageContent(message.forward, message.force);
    }
    else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean'
            ? message.disappearingMessagesInChat
                ? WA_DEFAULT_EPHEMERAL
                : 0
            : message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    }
    else if (hasNonNullishProperty(message, 'groupInvite')) {
        m.groupInviteMessage = {};
        m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
        m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration;
        m.groupInviteMessage.caption = message.groupInvite.text;
        m.groupInviteMessage.groupJid = message.groupInvite.jid;
        m.groupInviteMessage.groupName = message.groupInvite.subject;
        //TODO: use built-in interface and get disappearing mode info etc.
        //TODO: cache / use store!?
        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
            if (pfpUrl) {
                const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher });
                if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    m.groupInviteMessage.jpegThumbnail = buf;
                }
            }
        }
    }
    else if (hasNonNullishProperty(message, 'pin')) {
        m.pinInChatMessage = {};
        m.messageContextInfo = {};
        m.pinInChatMessage.key = message.pin;
        m.pinInChatMessage.type = message.type;
        m.pinInChatMessage.senderTimestampMs = Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;
    }
    else if (hasNonNullishProperty(message, 'buttonReply')) {
        switch (message.type) {
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                };
                break;
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                };
                break;
        }
    }
    else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    }
    else if (hasNonNullishProperty(message, 'product')) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = WAProto.Message.ProductMessage.create({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage
            }
        });
    }
    else if (hasNonNullishProperty(message, 'listReply')) {
        m.listResponseMessage = { ...message.listReply };
    }
    else if (hasNonNullishProperty(message, 'event')) {
        m.eventMessage = {};
        const startTime = Math.floor(message.event.startDate.getTime() / 1000);
        if (message.event.call && options.getCallLink) {
            const token = await options.getCallLink(message.event.call, { startTime });
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.event.messageSecret || randomBytes(32)
        };
        m.eventMessage.name = message.event.name;
        m.eventMessage.description = message.event.description;
        m.eventMessage.startTime = startTime;
        m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined;
        m.eventMessage.isCanceled = message.event.isCancelled ?? false;
        m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
        m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
        m.eventMessage.location = message.event.location;
    }
    else if (hasNonNullishProperty(message, 'poll')) {
        (_a = message.poll).selectableCount || (_a.selectableCount = 0);
        (_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false);
        if (!Array.isArray(message.poll.values)) {
            throw new Boom('Invalid poll values', { statusCode: 400 });
        }
        if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
            throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
                statusCode: 400
            });
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.poll.messageSecret || randomBytes(32)
        };
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName }))
        };
        if (message.poll.toAnnouncementGroup) {
            // poll v2 is for community announcement groups (single select and multiple)
            m.pollCreationMessageV2 = pollCreationMessage;
        }
        else {
            if (message.poll.selectableCount === 1) {
                //poll v3 is for single select polls
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                // poll for multiple choice polls
                m.pollCreationMessage = pollCreationMessage;
            }
        }
    }
    else if (hasNonNullishProperty(message, 'album')) {
        m.albumMessage = {
            expectedImageCount: message.album.expectedImageCount,
            expectedVideoCount: message.album.expectedVideoCount
        };
    }
    else if (hasNonNullishProperty(message, 'sharePhoneNumber')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    }
    else if (hasNonNullishProperty(message, 'requestPhoneNumber')) {
        m.requestPhoneNumberMessage = {};
    }
    else if (hasNonNullishProperty(message, 'limitSharing')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
            limitSharing: {
                sharingLimited: message.limitSharing === true,
                trigger: 1,
                limitSharingSettingTimestamp: Date.now(),
                initiatedByMe: true
            }
        };
    }
    else {
        m = await prepareWAMessageMedia(anyMsg, options);
    }
    if ((anyMsg.buttons !== undefined && anyMsg.buttons !== null) ||
        (anyMsg.interactiveButtons !== undefined && anyMsg.interactiveButtons !== null)) {
        const rawBtns = anyMsg.buttons || anyMsg.interactiveButtons;
        const nativeButtons = (Array.isArray(rawBtns) ? rawBtns : []).map(convertButtonToNative);
        const hasMedia = Boolean(m && (m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.locationMessage));
        const interactiveMessage = {
            body: {
                text: anyMsg.text || anyMsg.caption || ' '
            },
            footer: anyMsg.footer ? { text: anyMsg.footer } : undefined,
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: nativeButtons
            })
        };
        if (hasMedia || anyMsg.title) {
            interactiveMessage.header = {
                title: anyMsg.title || undefined,
                subtitle: anyMsg.subtitle || undefined,
                hasMediaAttachment: hasMedia,
                ...(hasMedia ? m : {})
            };
        }
        if (anyMsg.contextInfo) {
            interactiveMessage.contextInfo = anyMsg.contextInfo;
        }
        if (anyMsg.mentions) {
            interactiveMessage.contextInfo = {
                ...(interactiveMessage.contextInfo || {}),
                mentionedJid: anyMsg.mentions
            };
        }
        const shouldWrapViewOnce = anyMsg.viewOnce !== false;
        m = prepareInteractiveMessage(interactiveMessage, {
            viewOnce: shouldWrapViewOnce
        });
    }
    else if (anyMsg.interactive !== undefined && anyMsg.interactive !== null) {
        m = prepareInteractiveMessage(anyMsg.interactive, {
            viewOnce: message.viewOnce !== false
        });
    }
    else if (anyMsg.interactiveMessage !== undefined && anyMsg.interactiveMessage !== null) {
        m = prepareInteractiveMessage(anyMsg.interactiveMessage, {
            viewOnce: message.viewOnce !== false
        });
    }
    else if (anyMsg.templateButtons !== undefined && anyMsg.templateButtons !== null) {
        const msg = {
            hydratedButtons: anyMsg.templateButtons
        };
        if (anyMsg.text !== undefined && anyMsg.text !== null) {
            msg.hydratedContentText = anyMsg.text;
        }
        else {
            if (anyMsg.caption !== undefined && anyMsg.caption !== null && anyMsg.caption) {
                msg.hydratedContentText = anyMsg.caption;
            }
            Object.assign(msg, m);
        }
        if (anyMsg.footer !== undefined && anyMsg.footer !== null && anyMsg.footer) {
            msg.hydratedFooterText = anyMsg.footer;
        }
        m = {
            templateMessage: {
                fourRowTemplate: msg,
                hydratedTemplate: msg
            }
        };
    }
    if (anyMsg.sections !== undefined && anyMsg.sections !== null) {
        const listMessage = {
            sections: anyMsg.sections,
            buttonText: anyMsg.buttonText,
            title: anyMsg.title,
            footerText: anyMsg.footer,
            description: anyMsg.text,
            listType: proto.Message.ListMessage.ListType.SINGLE_SELECT
        };
        m = { listMessage };
    }
    if (anyMsg.shop !== undefined && anyMsg.shop !== null) {
        const interactiveMessage = {
            shopStorefrontMessage: proto.Message.InteractiveMessage.ShopMessage.create({
                surface: anyMsg.shop,
                id: anyMsg.id
            })
        };
        if (anyMsg.text !== undefined && anyMsg.text !== null) {
            interactiveMessage.body = {
                text: anyMsg.text
            };
        }
        else if (anyMsg.caption !== undefined && anyMsg.caption !== null && anyMsg.caption) {
            interactiveMessage.body = {
                text: anyMsg.caption
            };
            interactiveMessage.header = {
                title: anyMsg.title,
                subtitle: anyMsg.subtitle,
                hasMediaAttachment: anyMsg.media ?? false,
                ...m
            };
        }
        if (anyMsg.footer !== undefined && anyMsg.footer !== null && anyMsg.footer) {
            interactiveMessage.footer = {
                text: anyMsg.footer
            };
        }
        if (anyMsg.title !== undefined && anyMsg.title !== null && anyMsg.title) {
            interactiveMessage.header = {
                title: anyMsg.title,
                subtitle: anyMsg.subtitle,
                hasMediaAttachment: anyMsg.media ?? false,
                ...m
            };
        }
        if (anyMsg.contextInfo !== undefined && anyMsg.contextInfo !== null && anyMsg.contextInfo) {
            interactiveMessage.contextInfo = anyMsg.contextInfo;
        }
        if (anyMsg.mentions !== undefined && anyMsg.mentions !== null && anyMsg.mentions) {
            interactiveMessage.contextInfo = { ...interactiveMessage.contextInfo, mentionedJid: anyMsg.mentions };
        }
        m = prepareInteractiveMessage(interactiveMessage, {
            viewOnce: message.viewOnce !== false
        });
    }
    if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce && !m.viewOnceMessage && !m.viewOnceMessageV2) {
        m = { viewOnceMessage: { message: m } };
    }
    if ((hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
        (hasOptionalProperty(message, 'mentionAll') && message.mentionAll)) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if (key && 'contextInfo' in key) {
            key.contextInfo = key.contextInfo || {};
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions;
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1;
            }
        }
        else if (key) {
            key.contextInfo = {
                mentionedJid: message.mentions,
                nonJidMentions: message.mentionAll ? 1 : 0
            };
        }
    }
    if (hasOptionalProperty(message, 'edit')) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        };
    }
    if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
        if (m?.botForwardedMessage?.message?.richResponseMessage) {
            const rich = m.botForwardedMessage.message.richResponseMessage;
            rich.contextInfo = { ...rich.contextInfo, ...message.contextInfo };
        }
        else {
            const messageType = Object.keys(m)[0];
            const key = m[messageType];
            if ('contextInfo' in key && !!key.contextInfo) {
                key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
            }
            else if (key) {
                key.contextInfo = message.contextInfo;
            }
        }
    }
    if (hasOptionalProperty(message, 'albumParentKey') && !!message.albumParentKey) {
        m.messageContextInfo = {
            ...m.messageContextInfo,
            messageAssociation: {
                associationType: WAProto.MessageAssociation.AssociationType.MEDIA_ALBUM,
                parentMessageKey: message.albumParentKey
            }
        };
    }
    if (shouldIncludeReportingToken(m)) {
        m.messageContextInfo = m.messageContextInfo || {};
        if (!m.messageContextInfo.messageSecret) {
            m.messageContextInfo.messageSecret = randomBytes(32);
        }
    }
    const isPrivChat = isPrivateChat(options.jid);
    const isExplicitAi = typeof message?.ai !== 'undefined' ? message.ai : options.ai;
    const isAiChatEnabled = options.aiChat !== false;
    const normMsg = normalizeMessageContent(m);
    const isInteractive = Boolean(normMsg?.interactiveMessage ||
        normMsg?.buttonsMessage ||
        normMsg?.listMessage ||
        m?.viewOnceMessage?.message?.interactiveMessage ||
        m?.viewOnceMessageV2?.message?.interactiveMessage);
    const shouldAddAi = !isInteractive &&
        (isExplicitAi !== undefined
            ? Boolean(isExplicitAi)
            : (isAiChatEnabled && isPrivChat));
    if (shouldAddAi && isPrivChat) {
        m.messageContextInfo = m.messageContextInfo || {};
        m.messageContextInfo.supportPayload = BIZ_BOT_SUPPORT_PAYLOAD;
    }
    if (!isInteractive) {
        injectAiBotInfo(m, {
            jid: options.jid,
            ai: typeof message?.ai !== 'undefined' ? message.ai : options.ai,
            aiChat: options.aiChat,
            aiBotName: message?.aiBotName || options.aiBotName,
            aiBotJid: message?.aiBotJid || options.aiBotJid
        });
    }
    return WAProto.Message.create(m);
};
/** Check if a jid is a 1-on-1 private chat (not a group, newsletter, or broadcast) */
export const isPrivateChat = (jid) => {
    if (!jid)
        return true;
    return !isJidGroup(jid) && !isJidNewsletter(jid) && !isJidStatusBroadcast(jid) && !isJidBroadcast(jid);
};
/**
 * Injects Meta AI bot badge and forwarding info into message contextInfo
 */
export const injectAiBotInfo = (m, options) => {
    // Only inject forwardedAiBotMessageInfo if an explicit bot name or jid is provided
    if (!options.aiBotName && !options.aiBotJid && typeof options.ai !== 'string') {
        return;
    }
    // Exclude newsletter and status broadcast (not supported in protocol)
    if (options.jid && (isJidNewsletter(options.jid) || isJidStatusBroadcast(options.jid))) {
        return;
    }
    const isPrivChat = isPrivateChat(options.jid);
    const isExplicitAi = options.ai;
    const isAiChatEnabled = options.aiChat !== false;
    const shouldAddAi = isExplicitAi !== undefined
        ? Boolean(isExplicitAi)
        : (isAiChatEnabled && isPrivChat);
    if (!shouldAddAi)
        return;
    if (m.botForwardedMessage)
        return;
    const inner = normalizeMessageContent(m) || m;
    let key = getContentType(inner);
    if (!key || key === 'protocolMessage' || key === 'reactionMessage')
        return;
    if (key === 'conversation') {
        const text = inner.conversation;
        delete inner.conversation;
        inner.extendedTextMessage = { text };
        if (m && m.conversation) {
            delete m.conversation;
            m.extendedTextMessage = inner.extendedTextMessage;
        }
        key = 'extendedTextMessage';
    }
    const botJid = options.aiBotJid || '867051314767696@bot';
    const target = inner[key];
    if (target && typeof target === 'object') {
        target.contextInfo = target.contextInfo || {};
        if (!target.contextInfo.forwardedAiBotMessageInfo) {
            target.contextInfo.forwardedAiBotMessageInfo = {
                botJid
            };
            if (options.aiBotName || typeof isExplicitAi === 'string') {
                target.contextInfo.forwardedAiBotMessageInfo.botName =
                    typeof isExplicitAi === 'string' ? isExplicitAi : options.aiBotName;
            }
        }
        if (typeof target.contextInfo.forwardOrigin === 'undefined') {
            target.contextInfo.forwardOrigin = proto.ContextInfo.ForwardOrigin.META_AI;
        }
        target.contextInfo.isForwarded = true;
        if (typeof target.contextInfo.forwardingScore !== 'number' || target.contextInfo.forwardingScore < 1) {
            target.contextInfo.forwardingScore = 1;
        }
    }
    if (m && inner && key && m[key]) {
        m[key] = inner[key];
    }
};
export const generateWAMessageFromContent = (jid, message, options) => {
    // set timestamp to now
    // if not specified
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    let key = getContentType(innerMessage);
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;
    if (key === 'conversation') {
        const text = innerMessage.conversation;
        delete innerMessage.conversation;
        innerMessage.extendedTextMessage = { text };
        if (message && message.conversation) {
            delete message.conversation;
            message.extendedTextMessage = innerMessage.extendedTextMessage;
        }
        key = 'extendedTextMessage';
    }
    if (quoted?.key && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe
            ? userJid // TODO: Add support for LIDs
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        // strip any redundant properties
        quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] });
        const quotedContent = quotedMsg[msgType];
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo;
        }
        const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {};
        contextInfo.participant = jidNormalizedUser(participant);
        contextInfo.stanzaId = quoted.key.id;
        contextInfo.quotedMessage = quotedMsg;
        // if a participant is quoted, then it must be a group
        // hence, remoteJid of group must also be entered
        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && innerMessage[key]) {
            /* @ts-ignore */
            innerMessage[key].contextInfo = contextInfo;
        }
    }
    if (
    // if we want to send a disappearing message
    !!options?.ephemeralExpiration &&
        // and it's not a protocol message -- delete, toggle disappear message
        key !== 'protocolMessage' &&
        // already not converted to disappearing message
        key !== 'ephemeralMessage' &&
        // newsletters don't support ephemeral messages
        !isJidNewsletter(jid)) {
        /* @ts-ignore */
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
            //ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
        };
    }
    injectAiBotInfo(innerMessage, {
        jid,
        ai: options?.ai,
        aiChat: options?.aiChat,
        aiBotName: options?.aiBotName,
        aiBotJid: options?.aiBotJid
    });
    if (message && innerMessage && key && message[key]) {
        message[key] = innerMessage[key];
    }
    message = WAProto.Message.create(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined, // TODO: Add support for LIDs
        status: WAMessageStatus.PENDING
    };
    return WAProto.WebMessageInfo.fromObject(messageJSON);
};
export const generateWAMessage = async (jid, content, options) => {
    // ensure msg ID is with every log
    options.logger = options?.logger?.child({ msgId: options.messageId });
    const ai = typeof content?.ai !== 'undefined' ? content.ai : options.ai;
    const aiBotName = content?.aiBotName || options.aiBotName;
    const aiBotJid = content?.aiBotJid || options.aiBotJid;
    const mergedOptions = { ...options, ai, aiBotName, aiBotJid, jid };
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, mergedOptions), mergedOptions);
};
/** Get the key to access the true type of content */
export const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
};
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined;
    }
    // set max iterations to prevent an infinite loop
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
    function getFutureProofMessage(message) {
        return (message?.associatedChildMessage ||
            message?.botForwardedMessage ||
            message?.botInvokeMessage ||
            message?.botTaskMessage ||
            message?.documentWithCaptionMessage ||
            message?.editedMessage ||
            message?.ephemeralMessage ||
            message?.eventCoverImage ||
            message?.groupMentionedMessage ||
            message?.groupStatusMentionMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2 ||
            message?.limitSharingMessage ||
            message?.lottieStickerMessage ||
            message?.newsletterAdminProfileMessage ||
            message?.newsletterAdminProfileMessageV2 ||
            message?.newsletterAdminProfileStatusMessage ||
            message?.spoilerMessage ||
            message?.statusAddYours ||
            message?.statusMentionMessage ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension);
    }
};
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export const extractMessageContent = (content) => {
    const extractFromTemplateMessage = (msg) => {
        if (msg.imageMessage) {
            return { imageMessage: msg.imageMessage };
        }
        else if (msg.documentMessage) {
            return { documentMessage: msg.documentMessage };
        }
        else if (msg.videoMessage) {
            return { videoMessage: msg.videoMessage };
        }
        else if (msg.locationMessage) {
            return { locationMessage: msg.locationMessage };
        }
        else {
            return {
                conversation: 'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
            };
        }
    };
    content = normalizeMessageContent(content);
    if (content?.buttonsMessage) {
        return extractFromTemplateMessage(content.buttonsMessage);
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate);
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate);
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate);
    }
    return content;
};
/**
 * Returns the device predicted by message ID
 */
export const getDevice = (id) => /^3A.{18}$/.test(id)
    ? 'ios'
    : /^3E.{20}$/.test(id)
        ? 'web'
        : /^(.{21}|.{32})$/.test(id)
            ? 'android'
            : /^(3F|.{18}$)/.test(id)
                ? 'desktop'
                : 'unknown';
/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) {
        Object.assign(recp, receipt);
    }
    else {
        msg.userReceipt.push(receipt);
    }
};
/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key);
    const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text = reaction.text || '';
    reactions.push(reaction);
    msg.reactions = reactions;
};
/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey);
    const reactions = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) {
        reactions.push(update);
    }
    msg.pollUpdates = reactions;
};
/** Update the message with a new event response */
export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey);
    const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID);
    responses.push(update);
    msg.eventResponses = responses;
};
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV2?.options ||
        message?.pollCreationMessageV3?.options ||
        [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = sha256(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        };
        return acc;
    }, {});
    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) {
            continue;
        }
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            let data = voteHashMap[hash];
            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                };
                data = voteHashMap[hash];
            }
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteHashMap);
}
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = {
            response: type,
            responders: []
        };
    }
    for (const update of eventResponses || []) {
        const responseType = update.eventResponse || 'UNKNOWN';
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
        }
    }
    return Object.values(responseMap);
}
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                };
            }
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};
const REUPLOAD_REQUIRED_STATUS = [410, 404];
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            typeof error?.status === 'number' && // treat errors with status as HTTP failures requiring reupload
            REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...');
            // request reupload
            message = await ctx.reuploadRequest(message);
            const result = await downloadMsg();
            return result;
        }
        throw error;
    });
    return result;
    async function downloadMsg() {
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new Boom('No message present', { statusCode: 400, data: message });
        }
        const contentType = getContentType(mContent);
        let mediaType = contentType?.replace('Message', '');
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new Boom(`"${contentType}" message is not a media message`);
        }
        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            };
            mediaType = 'thumbnail-link';
        }
        else {
            download = media;
        }
        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            return Buffer.concat(bufferArray);
        }
        return stream;
    }
};
/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage ||
        content?.imageMessage ||
        content?.videoMessage ||
        content?.audioMessage ||
        content?.stickerMessage;
    if (!mediaContent) {
        throw new Boom('given message is not a media message', { statusCode: 400, data: content });
    }
    return mediaContent;
};
//# sourceMappingURL=messages.js.map