// src/services/vtpass.service.js - COMPLETE PRODUCTION VERSION
const axios = require('axios');
const { client } = require('../config/redis');

const VTPASS_API_KEY = process.env.VTPASS_API_KEY;
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY;
const VTPASS_PUBLIC_KEY = process.env.VTPASS_PUBLIC_KEY;
const VTPASS_BASE_URL = process.env.VTPASS_BASE_URL || 'https://sandbox.vtpass.com/api';

if (!VTPASS_API_KEY || !VTPASS_SECRET_KEY) {
    console.error('❌ VTPass credentials not configured');
}

class VTPassService {
    /**
     * Generate unique request ID (VTPass format)
     */
    generateRequestId() {
        const now = new Date();
        const lagosTime = new Date(now.getTime() + 60 * 60 * 1000); // GMT+1
        const year = lagosTime.getUTCFullYear();
        const month = String(lagosTime.getUTCMonth() + 1).padStart(2, '0');
        const day = String(lagosTime.getUTCDate()).padStart(2, '0');
        const hours = String(lagosTime.getUTCHours()).padStart(2, '0');
        const minutes = String(lagosTime.getUTCMinutes()).padStart(2, '0');
        const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
        
        return `${year}${month}${day}${hours}${minutes}${random}`;
    }

    /**
     * Purchase Airtime
     */
    async purchaseAirtime({ serviceID, amount, phone }) {
        const requestId = this.generateRequestId();

        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/pay`,
                {
                    request_id: requestId,
                    serviceID,
                    amount,
                    phone
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.code !== '000') {
                // Wait and check status
                await new Promise(resolve => setTimeout(resolve, 3000));
                return await this.queryTransactionStatus(requestId);
            }

            return response.data;
        } catch (error) {
            console.error('VTPass Airtime Error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'Airtime purchase failed'
            );
        }
    }

    /**
     * Purchase Data Bundle
     */
    async purchaseData({ serviceID, billersCode, variation_code, amount, phone }) {
        const requestId = this.generateRequestId();

        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/pay`,
                {
                    request_id: requestId,
                    serviceID,
                    billersCode,
                    variation_code,
                    amount,
                    phone
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.code !== '000') {
                await new Promise(resolve => setTimeout(resolve, 3000));
                return await this.queryTransactionStatus(requestId);
            }

            return response.data;
        } catch (error) {
            console.error('VTPass Data Error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'Data purchase failed'
            );
        }
    }

    /**
     * Purchase Electricity
     */
    async purchaseElectricity({ serviceID, billersCode, variation_code, amount, phone }) {
        const requestId = this.generateRequestId();

        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/pay`,
                {
                    request_id: requestId,
                    serviceID,
                    billersCode,
                    variation_code,
                    amount,
                    phone
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.code !== '000') {
                await new Promise(resolve => setTimeout(resolve, 3000));
                return await this.queryTransactionStatus(requestId);
            }

            return response.data;
        } catch (error) {
            console.error('VTPass Electricity Error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'Electricity purchase failed'
            );
        }
    }

    /**
     * Purchase TV Subscription
     */
    async purchaseTVSubscription({ serviceID, billersCode, variation_code, amount, phone }) {
        const requestId = this.generateRequestId();

        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/pay`,
                {
                    request_id: requestId,
                    serviceID,
                    billersCode,
                    variation_code,
                    amount,
                    phone,
                    subscription_type: 'renew'
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.code !== '000') {
                await new Promise(resolve => setTimeout(resolve, 3000));
                return await this.queryTransactionStatus(requestId);
            }

            return response.data;
        } catch (error) {
            console.error('VTPass TV Error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'TV subscription failed'
            );
        }
    }

    /**
     * Get Data Plans (with Redis caching)
     */
    async getDataPlans(serviceID) {
        const cacheKey = `vtpass:plans:${serviceID}`;

        try {
            // Check cache first
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // Fetch from VTPass
            const response = await axios.get(
                `${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`,
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'public-key': VTPASS_PUBLIC_KEY
                    }
                }
            );

            const plans = response.data?.content?.variations || 
                         response.data?.content?.varations || 
                         [];

            // Cache for 24 hours
            await client.setEx(cacheKey, 86400, JSON.stringify(plans));

            return plans;
        } catch (error) {
            console.error('Get data plans error:', error.response?.data || error.message);
            throw new Error('Failed to fetch data plans');
        }
    }

    /**
     * Get TV Bouquets (with Redis caching)
     */
    async getTVBouquets(serviceID) {
        const cacheKey = `vtpass:bouquets:${serviceID}`;

        try {
            // Check cache
            const cached = await client.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // Fetch from VTPass
            const response = await axios.get(
                `${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`,
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'public-key': VTPASS_PUBLIC_KEY
                    }
                }
            );

            const bouquets = response.data?.content?.variations || 
                            response.data?.content?.varations || 
                            [];

            // Cache for 24 hours
            await client.setEx(cacheKey, 86400, JSON.stringify(bouquets));

            return bouquets;
        } catch (error) {
            console.error('Get TV bouquets error:', error.response?.data || error.message);
            throw new Error('Failed to fetch TV bouquets');
        }
    }

    /**
     * Verify Meter Number
     */
    async verifyMeterNumber({ serviceID, billersCode }) {
        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/merchant-verify`,
                {
                    serviceID,
                    billersCode
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.content?.Customer_Name) {
                return response.data.content;
            }

            throw new Error(
                response.data?.content?.error || 
                response.data?.response_description || 
                'Invalid meter number'
            );
        } catch (error) {
            console.error('Meter verification error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'Meter verification failed'
            );
        }
    }

    /**
     * Verify SmartCard Number
     */
    async verifySmartCard(serviceID, billersCode) {
        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/merchant-verify`,
                {
                    serviceID,
                    billersCode
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data?.content) {
                return response.data.content;
            }

            throw new Error(
                response.data?.response_description || 
                'Invalid smartcard number'
            );
        } catch (error) {
            console.error('Smartcard verification error:', error.response?.data || error.message);
            throw new Error(
                error.response?.data?.response_description || 
                'Smartcard verification failed'
            );
        }
    }

    /**
     * Query Transaction Status
     */
    async queryTransactionStatus(requestId) {
        try {
            const response = await axios.post(
                `${VTPASS_BASE_URL}/requery`,
                {
                    request_id: requestId
                },
                {
                    headers: {
                        'api-key': VTPASS_API_KEY,
                        'secret-key': VTPASS_SECRET_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error) {
            console.error('Transaction query error:', error.response?.data || error.message);
            throw new Error('Transaction query failed');
        }
    }
}

module.exports = new VTPassService();