import { Debug } from '../../core/debug.js';
import { http } from '../../platform/net/http.js';
import { standardMaterialCubemapParameters, standardMaterialTextureParameters } from '../../scene/materials/standard-material-parameters.js';
import { AssetReference } from '../asset/asset-reference.js';
import { JsonStandardMaterialParser } from '../parsers/material/json-standard-material.js';
import { ResourceHandler } from './handler.js';
import { getBuiltInTexture } from '../../platform/graphics/built-in-textures.js';

/**
 * @import { AppBase } from '../app-base.js'
 */

const PLACEHOLDER_MAP = {
    aoMap: 'white',
    aoDetailMap: 'white',
    diffuseMap: 'gray',
    diffuseDetailMap: 'gray',
    specularMap: 'gray',
    specularityFactorMap: 'white',
    metalnessMap: 'black',
    glossMap: 'gray',
    sheenMap: 'black',
    sheenGlossMap: 'gray',
    clearCoatMap: 'black',
    clearCoatGlossMap: 'gray',
    clearCoatNormalMap: 'normal',
    refractionMap: 'white',
    emissiveMap: 'gray',
    normalMap: 'normal',
    normalDetailMap: 'normal',
    heightMap: 'gray',
    opacityMap: 'gray',
    sphereMap: 'gray',
    lightMap: 'white',
    thicknessMap: 'black',
    iridescenceMap: 'black',
    iridescenceThicknessMap: 'black',
    envAtlas: 'black',
    anisotropyMap: 'black'
};

/**
 * Resource handler used for loading {@link Material} resources.
 *
 * @category Graphics
 */
class MaterialHandler extends ResourceHandler {
    /**
     * Create a new MaterialHandler instance.
     *
     * @param {AppBase} app - The running {@link AppBase}.
     * @ignore
     */
    constructor(app) {
        super(app, 'material');

        this._assets = app.assets;
        this._device = app.graphicsDevice;
        this._parser = new JsonStandardMaterialParser();
    }

    load(url, callback) {
        if (typeof url === 'string') {
            url = {
                load: url,
                original: url
            };
        }

        // Loading from URL (engine-only)
        http.get(url.load, {
            retry: this.maxRetries > 0,
            maxRetries: this.maxRetries
        }, (err, response) => {
            if (!err) {
                if (callback) {
                    response._engine = true;
                    callback(null, response);
                }
            } else {
                if (callback) {
                    callback(`Error loading material: ${url.original} [${err}]`);
                }
            }
        });
    }

    open(url, data) {
        const material = this._parser.parse(data);

        // temp storage for engine-only as we need this during patching
        if (data._engine) {
            material._data = data;
            delete data._engine;
        }

        return material;
    }

    patch(asset, assets) {
        // in an engine-only environment we manually copy the source data into the asset
        if (asset.resource._data) {
            asset._data = asset.resource._data; // use _data to avoid firing events
            delete asset.resource._data; // remove from temp storage
        }

        // patch the name of the asset over the material name property
        asset.data.name = asset.name;
        asset.resource.name = asset.name;

        this._bindAndAssignAssets(asset, assets);

        asset.off('unload', this._onAssetUnload, this);
        asset.on('unload', this._onAssetUnload, this);
    }

    _onAssetUnload(asset) {
        // remove the parameter block we created which includes texture references
        delete asset.data.parameters;
        delete asset.data.chunks;
        delete asset.data.name;
    }

    _assignTexture(parameterName, materialAsset, texture) {
        // NB removed swapping out asset id for resource here
        materialAsset.resource[parameterName] = texture;
    }

    // returns the correct placeholder texture for the texture parameter
    _getPlaceholderTexture(parameterName) {
        const placeholder = PLACEHOLDER_MAP[parameterName];
        Debug.assert(placeholder, `No placeholder texture found for parameter: ${parameterName}`);
        return getBuiltInTexture(this._device, placeholder);
    }

    // assign a placeholder texture while waiting for one to load
    _assignPlaceholderTexture(parameterName, materialAsset) {

        materialAsset.resource[parameterName] = this._getPlaceholderTexture(parameterName);
    }

    _onTextureLoad(parameterName, materialAsset, textureAsset) {
        this._assignTexture(parameterName, materialAsset, textureAsset.resource);
        materialAsset.resource.update();
    }

    _onTextureAdd(parameterName, materialAsset, textureAsset) {
        this._assets.load(textureAsset);
    }

    _onTextureRemoveOrUnload(parameterName, materialAsset, textureAsset) {
        const material = materialAsset.resource;
        if (material) {
            if (materialAsset.resource[parameterName] === textureAsset.resource) {
                this._assignPlaceholderTexture(parameterName, materialAsset);
                material.update();
            }
        }
    }

    _assignCubemap(parameterName, materialAsset, textures) {
        // the primary cubemap texture
        materialAsset.resource[parameterName] = textures[0];

        // set prefiltered textures
        if (parameterName === 'cubeMap') {
            const prefiltered = textures.slice(1);
            if (prefiltered.every(t => t)) {
                materialAsset.resource.prefilteredCubemaps = prefiltered;
            } else if (prefiltered[0]) {
                materialAsset.resource.envAtlas = prefiltered[0];
            }
        }
    }

    _onCubemapLoad(parameterName, materialAsset, cubemapAsset) {
        this._assignCubemap(parameterName, materialAsset, cubemapAsset.resources);
        this._parser.initialize(materialAsset.resource, materialAsset.data);
    }

    _onCubemapAdd(parameterName, materialAsset, cubemapAsset) {
        this._assets.load(cubemapAsset);
    }

    _onCubemapRemoveOrUnload(parameterName, materialAsset, cubemapAsset) {
        const material = materialAsset.resource;

        if (materialAsset.data.prefilteredCubeMap128 === cubemapAsset.resources[1]) {
            this._assignCubemap(parameterName, materialAsset, [null, null, null, null, null, null, null]);
            material.update();
        }
    }

    _bindAndAssignAssets(materialAsset, assets) {
        // always migrate before updating material from asset data
        const data = this._parser.migrate(materialAsset.data);

        const material = materialAsset.resource;

        const pathMapping = (data.mappingFormat === 'path');

        const TEXTURES = standardMaterialTextureParameters;

        let i, name, assetReference;
        // iterate through all texture parameters
        for (i = 0; i < TEXTURES.length; i++) {
            name = TEXTURES[i];

            assetReference = material._assetReferences[name];

            // data[name] contains an asset id for a texture
            // if we have an asset id and nothing is assigned to the texture resource or the placeholder texture is assigned
            // or the data has changed
            const dataAssetId = data[name];

            const materialTexture = material[name];
            const isPlaceHolderTexture = materialTexture === this._getPlaceholderTexture(name);
            const dataValidated = data.validated;

            if (dataAssetId && (!materialTexture || !dataValidated || isPlaceHolderTexture)) {
                if (!assetReference) {
                    assetReference = new AssetReference(name, materialAsset, assets, {
                        load: this._onTextureLoad,
                        add: this._onTextureAdd,
                        remove: this._onTextureRemoveOrUnload,
                        unload: this._onTextureRemoveOrUnload
                    }, this);

                    material._assetReferences[name] = assetReference;
                }

                if (pathMapping) {
                    // texture paths are measured from the material directory
                    assetReference.url = materialAsset.getAbsoluteUrl(dataAssetId);
                } else {
                    assetReference.id = dataAssetId;
                }

                if (assetReference.asset) {
                    if (assetReference.asset.resource) {
                        // asset is already loaded
                        this._assignTexture(name, materialAsset, assetReference.asset.resource);
                    } else {
                        this._assignPlaceholderTexture(name, materialAsset);
                    }

                    assets.load(assetReference.asset);
                }
            } else {
                if (assetReference) {
                    // texture has been removed
                    if (pathMapping) {
                        assetReference.url = null;
                    } else {
                        assetReference.id = null;
                    }
                } else {
                    // no asset reference and no data field
                    // do nothing
                }
            }
        }

        const CUBEMAPS = standardMaterialCubemapParameters;

        // iterate through all cubemap parameters
        for (i = 0; i < CUBEMAPS.length; i++) {
            name = CUBEMAPS[i];

            assetReference = material._assetReferences[name];

            // data[name] contains an asset id for a cubemap
            // if we have a asset id and the prefiltered cubemap data is not set
            if (data[name] && !materialAsset.data.prefilteredCubeMap128) {
                if (!assetReference) {
                    assetReference = new AssetReference(name, materialAsset, assets, {
                        load: this._onCubemapLoad,
                        add: this._onCubemapAdd,
                        remove: this._onCubemapRemoveOrUnload,
                        unload: this._onCubemapRemoveOrUnload
                    }, this);

                    material._assetReferences[name] = assetReference;
                }

                if (pathMapping) {
                    assetReference.url = data[name];
                } else {
                    assetReference.id = data[name];
                }

                if (assetReference.asset) {
                    if (assetReference.asset.loaded) {
                        // asset loaded
                        this._assignCubemap(name, materialAsset, assetReference.asset.resources);
                    }

                    assets.load(assetReference.asset);
                }
            }


        }

        // call to re-initialize material after all textures assigned
        this._parser.initialize(material, data);
    }
}

export { MaterialHandler };
