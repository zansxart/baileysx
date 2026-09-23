import { getRandomValues, randomUUID } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { DONATE_URL, LEXER_REGEX } from '../Defaults/index.js';
import { CodeHighlightType, RichSubMessageType } from '../Types/RichType.js';
import { LANGUAGE_KEYWORDS } from '../WABinary/constants.js';
const NOOP = new Set([]);
export const tokenizeCode = (code, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || NOOP;
    const blocks = [];
    LEXER_REGEX.lastIndex = 0;
    let match;
    while ((match = LEXER_REGEX.exec(code)) !== null) {
        if (match[1]) {
            blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] });
        }
        else if (match[2]) {
            blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] });
        }
        else if (match[3]) {
            blocks.push({
                highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
                codeContent: match[3],
            });
        }
        else if (match[4]) {
            blocks.push({
                highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
                codeContent: match[4],
            });
        }
        else if (match[5]) {
            blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] });
        }
        else {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] || '' });
        }
    }
    return blocks;
};
export const toUnified = (submessages, uuid) => ({
    __typename: 'GenAIUnifiedResponse',
    response_id: uuid || randomUUID(),
    sections: submessages.map((submessage) => {
        if (submessage.html || submessage.payload) {
            return {
                __typename: 'GenAIUnifiedResponseSection',
                view_model: {
                    primitive: {
                        trusted_sources: [],
                        payload: submessage.html || submessage.payload,
                        __typename: submessage.primitiveType || 'FOAHtmlPrimitiveDemoDONOTUSE'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }
        switch (submessage.messageType) {
            case RichSubMessageType.CODE: {
                const codeMetadata = submessage.codeMetadata;
                return {
                    __typename: 'GenAIUnifiedResponseSection',
                    view_model: {
                        primitive: {
                            language: codeMetadata.codeLanguage,
                            code_blocks: codeMetadata.codeBlocks.map((block) => ({
                                content: block.codeContent,
                                type: CodeHighlightType[block.highlightType]
                            })),
                            __typename: 'GenAICodeUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
            }
            case RichSubMessageType.TABLE: {
                const tableMetadata = submessage.tableMetadata;
                return {
                    __typename: 'GenAIUnifiedResponseSection',
                    view_model: {
                        primitive: {
                            title: tableMetadata.title,
                            rows: tableMetadata.rows.map((row) => ({
                                is_header: row.isHeading,
                                cells: row.items,
                                markdown_cells: row.items.map((item) => ({ text: item }))
                            })),
                            __typename: 'GenATableUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
            }
            case RichSubMessageType.TEXT: {
                return {
                    __typename: 'GenAIUnifiedResponseSection',
                    view_model: {
                        primitive: {
                            text: submessage.messageText,
                            inline_entities: submessage.inlineEntities || [],
                            __typename: 'GenAIMarkdownTextUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
            }
            default:
                if (submessage.view_model) {
                    return {
                        __typename: 'GenAIUnifiedResponseSection',
                        ...submessage
                    };
                }
                return submessage;
        }
    })
});
export const botMetadataSignature = () => {
    const signatureMaterial = Buffer.from('\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u00564.7\u002D\u0056\u0065\u0072\u0069\u0066\u0069\u0063\u0061\u0074\u0069\u006F\u006E\u0053\u0069\u0067\u006E\u0061\u0074\u0075\u0072\u0065\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061');
    const randomBuf = Buffer.alloc(64 - signatureMaterial.length);
    getRandomValues(randomBuf);
    return Buffer.concat([signatureMaterial, randomBuf]).toString('base64');
};
export const botMetadataCertificate = (length = 684) => {
    const certificateMaterial = Buffer.from('\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u00564.7\u002D\u0043\u0065\u0072\u0074\u0069\u0066\u0069\u0063\u0061\u0074\u0065\u0043\u0068\u0061\u0069\u006E\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061');
    const randomBuf = Buffer.alloc(length - certificateMaterial.length);
    getRandomValues(randomBuf);
    return Buffer.concat([certificateMaterial, randomBuf]).toString('base64');
};
export const wrapToBotForwardedMessage = (richResponseMessage) => ({
    messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        botMetadata: {
            verificationMetadata: {
                proofs: [
                    {
                        certificateChain: [
                            botMetadataCertificate(684),
                            botMetadataCertificate(892)
                        ],
                        version: 1,
                        useCase: 1,
                        signature: botMetadataSignature()
                    }
                ]
            }
        }
    },
    botForwardedMessage: {
        message: { richResponseMessage }
    }
});
export const prepareAiTextMessage = (text, options = {}) => {
    const uuid = randomUUID();
    const responseId = randomUUID();
    const section = {
        view_model: {
            primitive: {
                text,
                __typename: 'GenAIMarkdownTextUXPrimitive'
            },
            __typename: 'GenAISingleLayoutViewModel'
        }
    };
    const submessages = [
        {
            messageType: 2,
            messageText: text
        }
    ];
    const unifiedData = Buffer.from(JSON.stringify({
        response_id: responseId,
        sections: [section]
    })).toString('base64');
    const contextInfo = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
        forwardOrigin: 4,
        ...(options.contextInfo || {})
    };
    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: {
            data: unifiedData
        },
        contextInfo
    });
    const message = wrapToBotForwardedMessage(richResponseMessage);
    const botMetadata = message.messageContextInfo.botMetadata;
    botMetadata.messageDisclaimerText = options.disclaimerText || options.title || 'Meta AI';
    botMetadata.botResponseId = uuid;
    return message;
};
export const prepareRichResponseMessage = (content) => {
    const { alignment, code, contentText, disclaimerText, footerText, headerText, html, imageText, inlineImage, inlineVideo, items, language, latex, links, noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title } = content;
    const submessages = [];
    if (html) {
        submessages.push({
            messageType: RichSubMessageType.DYNAMIC,
            messageText: 'HTML',
            html
        });
    }
    if (Array.isArray(richResponse)) {
        for (const submessage of richResponse) {
            if (submessage.html) {
                submessages.push({
                    messageType: RichSubMessageType.DYNAMIC,
                    messageText: 'HTML',
                    html: submessage.html
                });
            }
            else if (submessage.text) {
                submessages.push({
                    messageType: RichSubMessageType.TEXT,
                    messageText: submessage.text,
                    inlineEntities: submessage.inlineEntities
                });
            }
            else if (submessage.code) {
                submessages.push({
                    messageType: RichSubMessageType.CODE,
                    codeMetadata: {
                        codeLanguage: submessage.language,
                        codeBlocks: submessage.code
                    }
                });
            }
            else if (submessage.items) {
                submessages.push({
                    messageType: RichSubMessageType.CONTENT_ITEMS,
                    contentItemsMetadata: {
                        itemsMetadata: submessage.items,
                        contentType: proto.AIRichResponseContentItemsMetadata?.ContentType?.CAROUSEL || 1
                    }
                });
            }
            else if (submessage.inlineImage) {
                submessages.push({
                    messageType: RichSubMessageType.INLINE_IMAGE,
                    imageMetadata: {
                        imageUrl: submessage.inlineImage,
                        imageText: submessage.imageText,
                        alignment: submessage.alignment,
                        tapLinkUrl: submessage.tapLinkUrl
                    }
                });
            }
            else if (submessage.inlineVideo) {
                submessages.push({
                    messageType: RichSubMessageType.TEXT,
                    messageText: 'INLINE_VIDEO'
                });
            }
            else if (submessage.latex) {
                submessages.push({
                    messageType: RichSubMessageType.LATEX,
                    latexMetadata: {
                        text: submessage.text,
                        expressions: submessage.latex
                    }
                });
            }
            else if (submessage.table) {
                submessages.push({
                    messageType: RichSubMessageType.TABLE,
                    tableMetadata: {
                        title: submessage.title,
                        rows: submessage.table
                    }
                });
            }
            else {
                submessages.push(submessage);
            }
        }
    }
    else if (!html) {
        if (headerText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: headerText
            });
        }
        if (contentText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: contentText
            });
        }
        if (code) {
            const lang = language || 'javascript';
            submessages.push({
                messageType: RichSubMessageType.CODE,
                codeMetadata: {
                    codeLanguage: lang,
                    codeBlocks: tokenizeCode(code, lang)
                }
            });
        }
        if (items) {
            submessages.push({
                messageType: RichSubMessageType.CONTENT_ITEMS,
                contentItemsMetadata: {
                    itemsMetadata: items,
                    contentType: proto.AIRichResponseContentItemsMetadata?.ContentType?.CAROUSEL || 1
                }
            });
        }
        if (inlineImage) {
            submessages.push({
                messageType: RichSubMessageType.INLINE_IMAGE,
                imageMetadata: {
                    imageUrl: inlineImage,
                    imageText,
                    alignment,
                    tapLinkUrl
                }
            });
        }
        if (inlineVideo) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'INLINE_VIDEO'
            });
        }
        if (latex) {
            submessages.push({
                messageType: RichSubMessageType.LATEX,
                latexMetadata: {
                    text: content.text,
                    expressions: latex
                }
            });
        }
        if (links && Array.isArray(links)) {
            links.forEach((linkField, index) => {
                const prefix = 'SS_' + index;
                const url = linkField.url || DONATE_URL;
                const sources = linkField.sources?.map((sourceField) => ({
                    source_type: 'THIRD_PARTY',
                    source_display_name: sourceField.displayName || 'Donate',
                    source_subtitle: sourceField.subtitle || 'Saweria',
                    source_url: sourceField.url || url
                }));
                submessages.push({
                    messageType: RichSubMessageType.TEXT,
                    messageText: linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
                    inlineEntities: [{
                            key: prefix,
                            metadata: {
                                reference_id: index + 1,
                                reference_url: url,
                                reference_title: linkField.title || 'For Donation via Saweria',
                                reference_display_name: linkField.displayName || 'Donation',
                                sources: sources || [],
                                __typename: 'GenAISearchCitationItem'
                            }
                        }]
                });
            });
        }
        if (posts) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'POSTS'
            });
        }
        if (products) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'PRODUCTS'
            });
        }
        if (suggested) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'SUGGESTED_PROMPT'
            });
        }
        if (table && Array.isArray(table)) {
            submessages.push({
                messageType: RichSubMessageType.TABLE,
                tableMetadata: {
                    title,
                    rows: table.map((itemsRow, index) => ({
                        isHeading: !noHeading && index === 0,
                        items: itemsRow
                    }))
                }
            });
        }
        if (footerText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: footerText
            });
        }
    }
    const uuid = randomUUID();
    const unified = toUnified(submessages, uuid);
    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: {
            data: Buffer.from(JSON.stringify(unified)).toString('base64')
        },
        contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
            forwardOrigin: 4
        }
    });
    const message = wrapToBotForwardedMessage(richResponseMessage);
    const botMetadata = message.messageContextInfo.botMetadata;
    if (disclaimerText) {
        botMetadata.messageDisclaimerText = disclaimerText;
    }
    botMetadata.botResponseId = uuid;
    return message;
};
//# sourceMappingURL=rich-message-utils.js.map