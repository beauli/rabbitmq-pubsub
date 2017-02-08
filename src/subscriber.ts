import * as amqp from "amqplib";
import { IRabbitMqConnectionFactory } from "./connectionFactory";
import * as Logger from "bunyan";
import * as Promisefy from "bluebird";
import { IQueueNameConfig, asPubSubQueueNameConfig } from "./common";
import { createChildLogger } from "./childLogger";

export interface IRabbitMqSubscriberDisposer {
    (): Promisefy<void>;
}

export class RabbitMqSubscriber {

    private dynamicQueueName;

    constructor(private logger: Logger, private connectionFactory: IRabbitMqConnectionFactory) {
        this.logger = createChildLogger(logger, "RabbitMqConsumer");
    }

    subscribe<T>(queue: string | IQueueNameConfig, action: (message: T) => Promisefy<any> | void): Promisefy<IRabbitMqSubscriberDisposer> {
        const queueConfig = asPubSubQueueNameConfig(queue);
        return this.connectionFactory.create()
            .then(connection => connection.createChannel())
            .then(channel => {
                this.logger.trace("got channel for queue '%s'", queueConfig.name);
                return this.setupChannel<T>(channel, queueConfig)
                    .then(() => this.subscribeToChannel<T>(channel, queueConfig, action))
            });
    }

    private setupChannel<T>(channel: amqp.Channel, queueConfig: IQueueNameConfig) {
        this.logger.trace("setup '%j'", queueConfig);
        return this.getChannelSetup(channel, queueConfig);
    }

    private subscribeToChannel<T>(channel: amqp.Channel, queueConfig: IQueueNameConfig, action: (message: T) => Promisefy<any> | void) {
        this.logger.trace("subscribing to queue '%s'", queueConfig.name);
        return channel.consume(this.dynamicQueueName, (message) => {
            let msg: T;
            Promisefy.try(() => {
                msg = this.getMessageObject<T>(message);
                this.logger.trace("message arrived from queue '%s' (%j)", queueConfig.name, msg)
                return action(msg);
            }).then(() => {
                this.logger.trace("message processed from queue '%s' (%j)", queueConfig.name, msg)
                channel.ack(message)
            }).catch((err) => {
                this.logger.error(err, "message processing failed from queue '%j' (%j)", queueConfig, msg);
                channel.nack(message, false, false);
            });
        }).then(opts => {
            this.logger.trace("subscribed to queue '%s' (%s)", queueConfig.name, opts.consumerTag)
            return (() => {
                this.logger.trace("disposing subscriber to queue '%s' (%s)", queueConfig.name, opts.consumerTag)
                return Promisefy.resolve(channel.cancel(opts.consumerTag)).return();
            }) as IRabbitMqSubscriberDisposer
        });
    }

    protected getMessageObject<T>(message: amqp.Message) {
        return JSON.parse(message.content.toString('utf8')) as T;
    }

     protected async getChannelSetup(channel: amqp.Channel, queueConfig: IQueueNameConfig) {
           await channel.assertExchange(queueConfig.dlx, 'fanout', this.getDLSettings());
           let result =  await channel.assertQueue(queueConfig.dlq, this.getQueueSettings(queueConfig.dlx));
           this.logger.debug("get amq result", result);
           this.dynamicQueueName = result.queue;
           await channel.bindQueue(this.dynamicQueueName, queueConfig.dlx, '');
    }

    protected getQueueSettings(deadletterExchangeName: string): amqp.Options.AssertQueue {
        return {
            exclusive: true
        }
    }

    protected getDLSettings(): amqp.Options.AssertQueue {
        return {
            durable: false
        }
    }
}
