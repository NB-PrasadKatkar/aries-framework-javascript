/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Attachment, AttachmentData } from '../../../../decorators/attachment/Attachment'
import type { SignCredentialOptions } from '../../../vc/models/W3cCredentialServiceOptions'
import type { W3cCredentialRecord } from '../../../vc/models/credential/W3cCredentialRecord'
import type {
  DeleteCredentialOptions,
  ServiceAcceptCredentialOptions,
  ServiceAcceptProposalOptions,
  ServiceAcceptRequestOptions,
} from '../../CredentialServiceOptions'
import type { ProposeCredentialOptions, RequestCredentialOptions } from '../../CredentialsModuleOptions'
import type { CredentialExchangeRecord } from '../../repository'
import type { CredPropose } from '../models/CredPropose'
import type {
  CredentialFormatSpec,
  FormatServiceCredentialAttachmentFormats,
  FormatServiceOfferAttachmentFormats,
  FormatServiceProposeAttachmentFormats,
  FormatServiceRequestCredentialOptions,
  HandlerAutoAcceptOptions,
  RevocationRegistry,
} from '../models/CredentialFormatServiceOptions'

import { Lifecycle, scoped } from 'tsyringe'

import { AriesFrameworkError } from '../../../../../src/error'
import { JsonTransformer } from '../../../../../src/utils/JsonTransformer'
import { uuid } from '../../../../../src/utils/uuid'
import { EventEmitter } from '../../../../agent/EventEmitter'
import { W3cCredentialService } from '../../../vc'
import { W3cVerifiableCredential, W3cCredential } from '../../../vc/models'
import { AutoAcceptCredential } from '../../CredentialAutoAcceptType'
import { CredentialResponseCoordinator } from '../../CredentialResponseCoordinator'
import { CredentialFormatType } from '../../CredentialsModuleOptions'
import { CredentialPreviewAttribute } from '../../models'
import { V2CredentialPreview } from '../../protocol/v2/V2CredentialPreview'
import { CredentialRepository } from '../../repository/CredentialRepository'
import { CredentialFormatService } from '../CredentialFormatService'

@scoped(Lifecycle.ContainerScoped)
export class JsonLdCredentialFormatService extends CredentialFormatService {
  public deleteCredentialById(
    _credentialRecord: CredentialExchangeRecord,
    _options: DeleteCredentialOptions
  ): Promise<void> {
    throw new Error('Method not implemented.')
  }
  protected credentialRepository: CredentialRepository // protected as in base class
  private w3cCredentialService: W3cCredentialService

  public constructor(
    credentialRepository: CredentialRepository,
    eventEmitter: EventEmitter,
    w3cCredentialService: W3cCredentialService
  ) {
    super(credentialRepository, eventEmitter)
    this.credentialRepository = credentialRepository
    this.w3cCredentialService = w3cCredentialService
  }

  public async processProposal(options: ServiceAcceptProposalOptions): Promise<void> {
    const credPropose = options.proposalAttachment?.getDataAsJson<SignCredentialOptions>()

    if (!credPropose) {
      throw new AriesFrameworkError('Missing jsonld credential proposal data payload')
    }

    options.credentialFormats = {
      jsonld: credPropose,
    }
  }

  public async createCredential(
    options: ServiceAcceptRequestOptions,
    credentialRecord: CredentialExchangeRecord,
    requestAttachment: Attachment
  ): Promise<FormatServiceCredentialAttachmentFormats> {
    if (!requestAttachment || !requestAttachment?.data?.base64) {
      throw new AriesFrameworkError(
        `Missing request attachment from request message, credential record id = ${credentialRecord.id}`
      )
    }

    const formats: CredentialFormatSpec = {
      attachId: uuid(),
      format: 'aries/ld-proof-vc@1.0',
    }

    const attachmentId = options.attachId ? options.attachId : formats.attachId

    // sign credential here. The credential subject is received as the request attachment
    // (attachment in the request message from holder to issuer)
    const credentialOptions = requestAttachment?.getDataAsJson<SignCredentialOptions>()
    const signCredentialOptions: SignCredentialOptions = {
      credential: JsonTransformer.fromJSON(credentialOptions.credential, W3cCredential),
      proofType: credentialOptions.proofType,
      verificationMethod: credentialOptions.verificationMethod,
    }

    const verifiableCredential = await this.w3cCredentialService.signCredential(signCredentialOptions)
    const issueAttachment: Attachment = this.getFormatData(verifiableCredential, attachmentId)

    return { format: formats, attachment: issueAttachment }
  }

  public getAttachment(formats: CredentialFormatSpec[], messageAttachment: Attachment[]): Attachment | undefined {
    const formatId = formats.find((f) => f.format.includes('aries'))
    const attachment = messageAttachment?.find((attachment) => attachment.id === formatId?.attachId)
    return attachment
  }

  public async createOffer(options: ServiceAcceptProposalOptions): Promise<FormatServiceOfferAttachmentFormats> {
    const formats: CredentialFormatSpec = {
      attachId: uuid(),
      format: 'aries/ld-proof-vc-detail@v1.0',
    }

    // if the proposal has an attachment Id use that, otherwise the generated id of the formats object
    const attachmentId = options.attachId ? options.attachId : formats.attachId

    // exchange can begin with proposal or offer
    let messageAttachment
    if (!options.proposalAttachment) {
      if (!options.credentialFormats.jsonld) {
        throw new AriesFrameworkError('create JsonLd offer: missing credential attachment')
      }
      messageAttachment = options.credentialFormats.jsonld
    } else {
      messageAttachment = options.proposalAttachment.getDataAsJson<SignCredentialOptions>()
    }
    const offersAttach: Attachment = this.getFormatData(messageAttachment, attachmentId)

    // need to provide an empty preview as per the spec
    const preview = new V2CredentialPreview({
      attributes: [],
    })

    return { format: formats, preview, attachment: offersAttach }
  }

  public processOffer(_attachment: Attachment, _credentialRecord: CredentialExchangeRecord): Promise<void> {
    return Promise.resolve()
  }

  public async createRequest(
    options: FormatServiceRequestCredentialOptions,
    credentialRecord: CredentialExchangeRecord
  ): Promise<FormatServiceCredentialAttachmentFormats> {
    if (!options.offerAttachment) {
      throw new AriesFrameworkError(
        `Missing attachment from offer message, credential record id = ${credentialRecord.id}`
      )
    }
    const formats: CredentialFormatSpec = {
      attachId: uuid(),
      format: 'aries/ld-proof-vc-detail@v1.0',
    }

    // W3C message exchange can begin with request or there could be an offer.
    // Use offer attachment as the credential if present
    // otherwise use the credential format payload passed in the options object

    const credOffer = options.offerAttachment.getDataAsJson<SignCredentialOptions>()
    const attachment = credOffer ? credOffer : options.jsonld?.credentialSubject

    const requestAttach: Attachment = this.getFormatData(attachment, formats.attachId)

    return { format: formats, attachment: requestAttach }
  }

  public shouldAutoRespondToProposal(options: HandlerAutoAcceptOptions): boolean {
    const autoAccept = CredentialResponseCoordinator.composeAutoAccept(
      options.credentialRecord.autoAcceptCredential,
      options.autoAcceptType
    )
    if (autoAccept === AutoAcceptCredential.Always) {
      return true
    }
    if (options.proposalAttachment && options.offerAttachment) {
      if (this.areCredentialsEqual(options.proposalAttachment.data, options.offerAttachment.data)) {
        return true
      }
    }

    return false
  }

  private areCredentialsEqual(message1: AttachmentData, message2: AttachmentData): boolean {
    return JSON.stringify(message1) === JSON.stringify(message2)
  }

  private arePreviousCredentialsEqual(
    request: AttachmentData,
    proposal?: AttachmentData,
    offer?: AttachmentData
  ): boolean {
    if (!request) {
      return false
    }
    if (proposal || offer) {
      const previousCredential = offer ? offer : proposal

      if (previousCredential) {
        if (this.areCredentialsEqual(previousCredential, request)) {
          return true
        }
        return true
      }
    }
    return false
  }

  public shouldAutoRespondToRequest(options: HandlerAutoAcceptOptions): boolean {
    const autoAccept = CredentialResponseCoordinator.composeAutoAccept(
      options.credentialRecord.autoAcceptCredential,
      options.autoAcceptType
    )

    if (!options.requestAttachment) {
      throw new AriesFrameworkError(`Missing Request Attachment for Credential Record ${options.credentialRecord.id}`)
    }
    if (autoAccept === AutoAcceptCredential.ContentApproved) {
      return this.arePreviousCredentialsEqual(
        options.requestAttachment.data,
        options.offerAttachment?.data,
        options.proposalAttachment?.data
      )
    }
    return false
  }
  private areCredentialValuesValid(_credentialRecord: CredentialExchangeRecord, _credentialAttachment: Attachment) {
    return true // temporary until we have the credential attributes to compare with credential attachment
  }

  public shouldAutoRespondToCredential(options: HandlerAutoAcceptOptions): boolean {
    const autoAccept = CredentialResponseCoordinator.composeAutoAccept(
      options.credentialRecord.autoAcceptCredential,
      options.autoAcceptType
    )

    if (autoAccept === AutoAcceptCredential.ContentApproved) {
      if (options.credentialAttachment) {
        return this.areCredentialValuesValid(options.credentialRecord, options.credentialAttachment)
      }
    }
    return false
  }

  public async processCredential(
    options: ServiceAcceptCredentialOptions,
    credentialRecord: CredentialExchangeRecord
  ): Promise<void> {
    // 1. check credential attachment is present
    // 2. Retrieve the credential attachment
    // 3. save the credential (store using w3cCredentialService)
    // 4. save the binding to credentials array in credential exchange record
    if (!options.credentialAttachment) {
      throw new AriesFrameworkError(
        `JsonLd processCredential - Missing credential attachment for record id ${credentialRecord.id}`
      )
    }
    const credentialAsJson = options.credentialAttachment.getDataAsJson<W3cVerifiableCredential>()

    const credential = JsonTransformer.fromJSON(credentialAsJson, W3cVerifiableCredential)

    const verifiableCredential: W3cCredentialRecord = await this.w3cCredentialService.storeCredential({
      record: credential,
    })

    // verifiableCredential.id = uu
    if (!verifiableCredential.credential.id) {
      throw new AriesFrameworkError(
        `JsonLd processCredential - Missing credential id in verifiable credential for record id ${credentialRecord.id}`
      )
    }
    credentialRecord.credentials.push({
      credentialRecordType: CredentialFormatType.JsonLd,
      credentialRecordId: verifiableCredential.id,
    })
  }

  public processRequest(_options: RequestCredentialOptions, _credentialRecord: CredentialExchangeRecord): void {
    throw new Error('Method not implemented.')
  }

  public createProposal(options: ProposeCredentialOptions): FormatServiceProposeAttachmentFormats {
    const format: CredentialFormatSpec = {
      attachId: 'ld_proof',
      format: 'aries/ld-proof-vc-detail@v1.0',
    }

    const attachment: Attachment = this.getFormatData(options.credentialFormats.jsonld, format.attachId)
    return { format, attachment }
  }
}
