import { getRandomValues, randomUUID } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { DONATE_URL, LEXER_REGEX } from '../Defaults/index.js'
import { CodeHighlightType, RichSubMessageType } from '../Types/RichType.js'
import { LANGUAGE_KEYWORDS } from '../WABinary/constants.js'

const NOOP = new Set<string>([])

export const tokenizeCode = (code: string, language: string = 'javascript') => {
	const keywords = (LANGUAGE_KEYWORDS as Record<string, Set<string>>)[language] || NOOP
	const blocks: { highlightType: CodeHighlightType; codeContent: string }[] = []
	LEXER_REGEX.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = LEXER_REGEX.exec(code)) !== null) {
		if (match[1]) {
			blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] })
		} else if (match[2]) {
			blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] })
		} else if (match[3]) {
			blocks.push({
				highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
				codeContent: match[3],
			})
		} else if (match[4]) {
			blocks.push({
				highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
				codeContent: match[4],
			})
		} else if (match[5]) {
			blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] })
		} else {
			blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] })
		}
	}
	return blocks
}

export const toUnified = (submessages: any[], uuid?: string) => ({
	response_id: uuid || randomUUID(),
	sections: submessages.map((submessage) => {
		switch (submessage.messageType) {
			case RichSubMessageType.CODE: {
				const codeMetadata = submessage.codeMetadata
				return {
					view_model: {
						primitive: {
							language: codeMetadata.codeLanguage,
							code_blocks: codeMetadata.codeBlocks.map((block: any) => ({
								content: block.codeContent,
								type: CodeHighlightType[block.highlightType]
							})),
							__typename: 'GenAICodeUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			}
			case RichSubMessageType.TABLE: {
				const tableMetadata = submessage.tableMetadata
				return {
					view_model: {
						primitive: {
							title: tableMetadata.title,
							rows: tableMetadata.rows.map((row: any) => ({
								is_header: row.isHeading,
								cells: row.items,
								markdown_cells: row.items.map((item: string) => ({ text: item }))
							})),
							__typename: 'GenATableUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			}
			case RichSubMessageType.TEXT: {
				return {
					view_model: {
						primitive: {
							text: submessage.messageText,
							inline_entities: submessage.inlineEntities || [],
							__typename: 'GenAIMarkdownTextUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			}
			default:
				return {}
		}
	})
})

export const botMetadataSignature = () => {
	const signature = new Uint8Array(64)
	getRandomValues(signature)
	return signature
}

export const botMetadataCertificate = (length = 685) => {
	const certificate = new Uint8Array(length)
	certificate[0] = 48
	certificate[1] = 130
	getRandomValues(certificate.subarray(2))
	return certificate
}

export const wrapToBotForwardedMessage = (richResponseMessage: any) => ({
	messageContextInfo: {
		botMetadata: {
			verificationMetadata: {
				proofs: [
					{
						certificateChain: [
							botMetadataCertificate(),
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
})

export const prepareRichResponseMessage = (content: any) => {
	const {
		alignment,
		code,
		contentText,
		disclaimerText,
		footerText,
		headerText,
		imageText,
		inlineImage,
		inlineVideo,
		items,
		language,
		latex,
		links,
		noHeading,
		posts,
		products,
		suggested,
		richResponse,
		table,
		tapLinkUrl,
		title
	} = content

	const submessages: any[] = []

	if (Array.isArray(richResponse)) {
		for (const submessage of richResponse) {
			if (submessage.text) {
				submessages.push({
					messageType: RichSubMessageType.TEXT,
					messageText: submessage.text,
					inlineEntities: submessage.inlineEntities
				})
			} else if (submessage.code) {
				submessages.push({
					messageType: RichSubMessageType.CODE,
					codeMetadata: {
						codeLanguage: submessage.language,
						codeBlocks: submessage.code
					}
				})
			} else if (submessage.items) {
				submessages.push({
					messageType: RichSubMessageType.CONTENT_ITEMS,
					contentItemsMetadata: {
						itemsMetadata: submessage.items,
						contentType: (proto as any).AIRichResponseContentItemsMetadata?.ContentType?.CAROUSEL || 1
					}
				})
			} else if (submessage.inlineImage) {
				submessages.push({
					messageType: RichSubMessageType.INLINE_IMAGE,
					imageMetadata: {
						imageUrl: submessage.inlineImage,
						imageText: submessage.imageText,
						alignment: submessage.alignment,
						tapLinkUrl: submessage.tapLinkUrl
					}
				})
			} else if (submessage.inlineVideo) {
				submessages.push({
					messageType: RichSubMessageType.TEXT,
					messageText: 'INLINE_VIDEO'
				})
			} else if (submessage.latex) {
				submessages.push({
					messageType: RichSubMessageType.LATEX,
					latexMetadata: {
						text: submessage.text,
						expressions: submessage.latex
					}
				})
			} else if (submessage.table) {
				submessages.push({
					messageType: RichSubMessageType.TABLE,
					tableMetadata: {
						title: submessage.title,
						rows: submessage.table
					}
				})
			} else {
				submessages.push(submessage)
			}
		}
	} else {
		if (headerText) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: headerText
			})
		}
		if (contentText) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: contentText
			})
		}
		if (code) {
			const lang = language || 'javascript'
			submessages.push({
				messageType: RichSubMessageType.CODE,
				codeMetadata: {
					codeLanguage: lang,
					codeBlocks: tokenizeCode(code, lang)
				}
			})
		}
		if (items) {
			submessages.push({
				messageType: RichSubMessageType.CONTENT_ITEMS,
				contentItemsMetadata: {
					itemsMetadata: items,
					contentType: (proto as any).AIRichResponseContentItemsMetadata?.ContentType?.CAROUSEL || 1
				}
			})
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
			})
		}
		if (inlineVideo) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: 'INLINE_VIDEO'
			})
		}
		if (latex) {
			submessages.push({
				messageType: RichSubMessageType.LATEX,
				latexMetadata: {
					text: content.text,
					expressions: latex
				}
			})
		}
		if (links && Array.isArray(links)) {
			links.forEach((linkField: any, index: number) => {
				const prefix = 'SS_' + index
				const url = linkField.url || DONATE_URL
				const sources = linkField.sources?.map((sourceField: any) => ({
					source_type: 'THIRD_PARTY',
					source_display_name: sourceField.displayName || 'Donate',
					source_subtitle: sourceField.subtitle || 'Saweria',
					source_url: sourceField.url || url
				}))
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
				})
			})
		}
		if (posts) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: 'POSTS'
			})
		}
		if (products) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: 'PRODUCTS'
			})
		}
		if (suggested) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: 'SUGGESTED_PROMPT'
			})
		}
		if (table && Array.isArray(table)) {
			submessages.push({
				messageType: RichSubMessageType.TABLE,
				tableMetadata: {
					title,
					rows: table.map((itemsRow: any, index: number) => ({
						isHeading: !noHeading && index === 0,
						items: itemsRow
					}))
				}
			})
		}
		if (footerText) {
			submessages.push({
				messageType: RichSubMessageType.TEXT,
				messageText: footerText
			})
		}
	}

	const uuid = randomUUID()
	const unified = toUnified(submessages, uuid)

	const richResponseMessage = proto.AIRichResponseMessage.create({
		submessages,
		messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
		unifiedResponse: {
			data: Buffer.from(JSON.stringify(unified))
		},
		contextInfo: {
			isForwarded: true,
			forwardingScore: 1,
			forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
			forwardOrigin: 4
		}
	})

	const message = wrapToBotForwardedMessage(richResponseMessage) as any
	const botMetadata = message.messageContextInfo.botMetadata
	if (disclaimerText) {
		botMetadata.messageDisclaimerText = disclaimerText
	}
	botMetadata.botResponseId = uuid
	return message
}
