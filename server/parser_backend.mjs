import express from "express"; // our backend server module
import path, { parse } from "path"; // path module (for files)
import busboy from "connect-busboy"; // middleware
import fs from "fs-extra"; // file system module for extra modifications
import { cp, mkdir } from "fs";
import ejs from "ejs"; // static templating

import decompress from "decompress"; // unzips files
import puppeteer, { Puppeteer, TimeoutError } from "puppeteer"; // headless browser for web scraping
import dotenv from "dotenv"; // use dotenv so we can access protected variables (like login info)

import {
    // these are all lists, their names are self explanatory
    followersList,
    followingList,
    mutualsList,
    nonMutualFollowersList,
    nonMutualFollowingList,
    mutualsUnfollowedYouList,
    mutualsYouUnfollowedList,
    personalInfo,
    indeterminateList,
    stillMutualsList
} from "./infoContainers.mjs"

import { arch, userInfo } from "os";
import { get } from "http";

// bool to determine if person put their login info or not
var userPutInInfo = false;

// dynamic variables that will update in ejs
var title = `Unfriended: An Instagram Data Parser`;
var fileUploadPrompt = ``;
var loginPrompt = ``;

// display elements variables used in the ejs file
var mutualsDisplay = ``;
var nonMutualFollowersDisplay = ``;
var nonMutualFollowingDisplay = ``;
var mutualsUnfollowedYouDisplay = ``;
var mutualsYouUnfollowedDisplay = ``;
var indeterminateDisplay = ``;
var stillMutualsDisplay = ``;

// variables to hold our browser object and page object when we use puppeteer
var browser, page;



// const rootDir = `C:/Users/weigh/Dropbox/Instagram Data Parser/Unfriended-Insta`;
const rootDir = path.dirname(import.meta.dirname);
dotenv.config({path: `./protectedVariables.env`});


// const ews = expressWs(express());
const app = express();
const PORT = process.env.PORT || 3000;




// set ejs as our view engine (for dynamic HTML changes)
app.set(`view engine`, `ejs`); 
// set directory for ejs files, default is just a views subfolder
app.set(`views`, path.join(rootDir, `client/public`)); 
// we need this to allow static files (html css) to work
app.use(express.static(path.join(rootDir, `client/public`)));

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});



// express router logic here

async function renderPage(pageRelativePath, dataObjs, responseBody) {

    const filePath = path.join(rootDir, pageRelativePath);

    // you can actually render the ejs file (the variables that are interpolated into the the file is the second argument)
    ejs.renderFile(
        filePath, 
        dataObjs,
        (err, str) => {

            responseBody.writeHead(200, {"Content-Type": "text/html"});
            responseBody.write(str);
        });
}

// root 
app.get(`/`, (req, res) => {

    res.redirect(`/main`);
});

// on home page
app.get(`/main`, async (req, res) => {

    await renderPage(`client/public/index.ejs`, {title, fileUploadPrompt}, res);
    res.end();
});

// on login
app.get(`/login`, async (req, res) => {

    await renderPage(`client/public/login.ejs`, {loginPrompt}, res);
    res.end();
});

// intermediate page, 
app.get(`/login/loading`, async (req, res) => {

    // if browser and page are alr assigned to a value (i.e. person goes back, remove the obj)
    if (browser && page)
        await terminateVirtualBrowserObjs();

    [browser, page] = await setupVirtualBrowserObjs();

    await loginToInstagram(page);

    if (await checkForLoginMistypes(page) == true) {
        loginPrompt = `Your login information was incorrect. Please try again.`;
        return res.redirect(`/login`);
    }
    
    res.redirect(`/compilingInfo`);
});

app.get(`/compilingInfo`, async (req, res) => {

    await renderPage(`client/public/compiling.ejs`, {mutualsDisplay, nonMutualFollowersDisplay, nonMutualFollowingDisplay}, res);

    if (userPutInInfo)
        res.write(`<script> alert("Check if you need to verify login!"); </script>`);

    await monitorForAdditionalLoginParams(page);

    res.write(`<script> alert("We have succesfully logged in. Checking data now."); </script>`);

    await initWebScraping(page);
    await terminateVirtualBrowserObjs(browser);

    console.log(`Data has been parsed`);

    mutualsUnfollowedYouDisplay = makeDataDisplayable(mutualsUnfollowedYouList);
    mutualsYouUnfollowedDisplay = makeDataDisplayable(mutualsYouUnfollowedList);
    indeterminateDisplay = makeDataDisplayable(indeterminateList);
    stillMutualsDisplay = makeDataDisplayable(stillMutualsList);

    res.write(`<script> window.location.href=window.location.origin+"/compilingInfo/results" </script>`);
    return res.end();
});

// final page
app.get(`/compilingInfo/results`, async (req, res) => {

    await renderPage(
        `client/public/results.ejs`, 
        {stillMutualsDisplay, mutualsUnfollowedYouDisplay, mutualsYouUnfollowedDisplay, indeterminateDisplay},
        res);
    
    res.write(`<script> alert("Results are ready to be checked."); </script>`)

    res.end();
});

// use our middleware to process any requests
app.use(busboy());
// set this website as our main path when we load server
// app.use(express.static(path.join(__dirname, 'public')));

// app.route() returns an instance of a single route, which can handle http verbs with optional middleware (busboy in this case).
// it's routed to /upload because of the action string in our index.html form
app.route(`/upload`)

    // send POST request to server: .post() usually submits data or uploads files, .get() usually retrives data or displays a page, .all() handles all http request
    .post(function (req, res, next) {
 
        // pipe our request to our middleware
        req.pipe(req.busboy)

        // on received file (you can think of 'file' as the DOM event listener and its output is the lambda function)
        // NOTE: this runs proportionally to the 
        req.busboy.on(`file`, (fieldName, fileStream, fileObj) => {

             // this is just to avoid an error if we didn't put any file in
            if(fileObj.filename == undefined || !fileObj.filename.includes(`.zip`)) {

                fileUploadPrompt = `Please put in a valid file (zip file)`;
                res.redirect(`/`);
                return;
            }

            // store the zip file in a not-created file in temp folder
            const tempPath = path.join(rootDir, `/server/uploads/temp/`, fileObj.filename);
            // store the final path in a new directory under uploads (recursive makes sure fs.makdirsync returns a string of the path and
            // prevents an error), do check if the directory already exists (this makes it so I dont have to keep deleting the file)
            // everytime I run node
            const newSubDirPath = path.join(rootDir, `/server/uploads/`, fileObj.filename);
            const finalPath = 
                fs.existsSync(newSubDirPath) ?
                    newSubDirPath: 
                    fs.mkdirSync(newSubDirPath, {recursive: true}); 

            // write stream to store our file stream (in temp path)
            const writeStream = fs.createWriteStream(tempPath);
            fileStream.pipe(writeStream);

            // once all chunks have been run through
            writeStream.on("close", ()=> {

                // decompress our file (async func, so we need to run whatever we need in .then)
                decompress(tempPath, finalPath)
                // if successful do this
                .then((files) => {

                    // order the data from the files we need 
                    getDataAndParse(finalPath, files);
                    // sort the data we parsed into more specific pieces (mutuals, nonmutuals, etc)
                    sortSpecificData();
                    // put the data to variables that will display it on the html 
                    mutualsDisplay = makeDataDisplayable(mutualsList);
                    nonMutualFollowersDisplay = makeDataDisplayable(nonMutualFollowersList);
                    nonMutualFollowingDisplay = makeDataDisplayable(nonMutualFollowingList);

                    console.log(`Files have been successfully decompressed and processed!`);

                    res.redirect(`/login`);
                })
                // if failed to decompress (or error in one of the functions that haven't been caught)
                .catch((error) => {
                    console.error(
                        `Failed to decompress file or something went wrong processing the decompressed data: ${error.mesasge}`
                    );
                    res.status(400).json({
                        status: 400,
                        message: `Bad Request: Invalid input provided`
                    });
                })
            });
        });
    });

// for authenticating logging in
app.route(`/user_login`)
    .post(function (req, res)  {

        // put the request in our middleware again
        // btw for busboy to work, you need the enctype to be "mutlipart/form-data" in your form
        req.pipe(req.busboy);

        // note, field records all input forms that don't upload files (e.g. type=`submit`, type=`text`, etc)
        req.busboy.on(`field`, (fieldName, value, fieldNameTruncated, valueTruncated) => {

            if (fieldName == `Username Input` && value != ``) {

                process.env.USER_USERNAME_INSTAGRAM = value;
                console.log(`User username stored`)
            }
            if (fieldName == `Password Input` && value != ``) {

                process.env.USER_PW_INSTAGRAM = value;
                console.log(`User password stored`)
            }
        });

        req.busboy.on(`finish`, ()=> {

            // we'll use this boolean later in puppeteer
            userPutInInfo = process.env.USER_USERNAME_INSTAGRAM != `` || process.env.USER_PW_INSTAGRAM != ``

            res.redirect(`/login/loading`);
        });
    });

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// general methods for parsing our data

function getDataAndParse(rootFilePath, files) {

    var followersFilePath, followingFilePath, personalInformationPath;

    // file paths for each file
    for (const file of files) {

        if (file.path.includes(`threads`))
            continue;

        // store path to our follower json file
        if (file.path.includes(`followers_1.json`))
            followersFilePath = path.join(rootFilePath, file.path);
        // store path to our following json file
        if (file.path.includes('following.json'))
            followingFilePath = path.join(rootFilePath, file.path);
        // store path to our personal info file
        if (file.path.includes(`personal_information.json`))
            personalInformationPath = path.join(rootFilePath, file.path);
    }

    // get followers
    try {
        const followers = JSON.parse(fs.readFileSync(followersFilePath, `utf-8`));

        // FIXME
        for (var follower of followers) {
            
            followersList[follower.string_list_data[0].value] = {
                href: follower.string_list_data[0].href,
                timestamp: follower.string_list_data[0].timestamp
            }
        }
        
        console.log(`Follower list has been configure`);
    }   
    catch(error) {
        console.error(`Could not access the follower JSON file at ${followersFilePath}: ${error.message}`);
    }

    // get people following
    try {
        const followings = JSON.parse(fs.readFileSync(followingFilePath, `utf-8`));

        followings.relationships_following.forEach((following) => { 
            
            followingList[following.title] = {
                href: following.string_list_data[0].href,
                timestamp: following.string_list_data[0].timestamp
            }
        });

        console.log(`Following List has been configured`);
    }   
    catch(error) {
        console.error(`Could not access the following JSON file at ${followingFilePath}: ${error.message}`);
    }

    // get our personal info 
    try {
        const ourInfo = JSON.parse(fs.readFileSync(personalInformationPath, `utf-8`));

        for (const info in ourInfo.profile_user[0].string_map_data) {

            // all the other information is extraneous info and is not exactly useful by any means
            personalInfo[`${info}`] = ourInfo.profile_user[0].string_map_data[info].value;
        }

        console.log(`Successfully parsed personal information`);
    }
    catch(error) {
        console.error(`Could not access the personal info JSON file at ${personalInformationPath}: ${error.message}`);
    }
}

function sortSpecificData() {

    try{
        for (const user in followersList) {

            // check if both followers and following list contain the same user
            if (user in followingList) {
                mutualsList[user] = followersList[user];
            }
            else {
                // else add it to a non mutual foilowers list 
                nonMutualFollowersList[user] = followersList[user];
            }
        }

        for (const user in followingList) {

            // check if the user is not in mutuals list
            if (!(user in mutualsList)) {
                // if it isn't add it to non mutual following list
                nonMutualFollowingList[user] = followingList[user];
            }
        }

        console.log(`Mutuals and related lists have been configured`);
    }
    catch (error) {

        throw console.log(`Something went wrong ordering the mutuals lists: ${error.message}`);
    }  
}

function makeDataDisplayable(dataList) {

    try {

        var displayList = ``;
        // this is to list all our names in numerical order on the page
        var userIndex = 0;

        for (const item in dataList) {

            userIndex++;

            displayList += `\n ${userIndex}. ${item}`;
        }

        console.log(`Data has been displayed properly`);

        return displayList;
    }   
    catch (error) {

        console.error(`An error occurred while making the information displayable: ${error.message}`);

        return ``;
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// puppeteer methods

async function setupVirtualBrowserObjs() {

    // open our browser obj
    const browser = await puppeteer.launch({
        enableExtensions: true,
        headless: true,
        args: [
            `--window-size=1920,1080`,
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    });

    // open a new page
    const page = await browser.newPage();

    return [browser, page]
}

async function loginToInstagram(pageObj) {

    // go to instagram
    await pageObj.goto(`https://instagram.com`, { waitUntil: `load`, timeout: 0 });

    // wait until an input element is visible (i.e. page is loaded in)
    await pageObj.waitForSelector(`input`);

    // just wait a bit here, sometimes the selector `[name=email]` can't be found lol
    await new Promise(r => setTimeout(r, 1000));

    // log in user credentials if they exist
    if (userPutInInfo) {
        await pageObj.type('[name=email]', process.env.USER_USERNAME_INSTAGRAM);
        await pageObj.type(`[name=pass]`, process.env.USER_PW_INSTAGRAM);
    }
    // else use or dummy credentials
    else {
        await pageObj.type('[name=email]', process.env.DUMMY_USERNAME_INSTAGRAM);
        await pageObj.type(`[name=pass]`, process.env.DUMMY_PW_UBIQ);
    }

    // find our login button
    await pageObj.$(`div[class*="xh8yej3"][role=button]`)
        .then((loginButton) => loginButton.click());
}

async function checkForLoginMistypes(pageObj) {

    try{
        await pageObj.waitForSelector(`[viewBox="0 0 24 24"][class*="xw4jnv"]`, {timeout: 7000});
    }
    catch (error) {
        console.log(`Login was valid`);
        return false
    }

    console.log(`Login was invalid`);
    return true;
}


async function monitorForAdditionalLoginParams(pageObj) {

    // sometimes due to possible bot activities, the login may ask for logging in again
    // this should compensate for it

    try {
        // find continue buttpn
        await pageObj.waitForSelector(`[aria-label="Continue"][role="button"]`, {timeout: 3000});
        // find the password entry part and fill it in
        await pageObj.type(`form[id="aymh_password_entry_view"]`, process.env.USER_PW_INSTAGRAM || process.env.DUMMY_PW_UBIQ);
        // submit
        await pageObj.click(`div[class*=xh8yej3][role="button"]`);
    }
    catch (error) {

        console.error(`We don't need to sign in again or we encountered an error: ${error.mesasge}`)
    }
}


async function initWebScraping(pageObj) {
    
    // wait for us to successfully load in
    await pageObj.waitForSelector(`[aria-label="Messages"]`, {timeout: 0});

    console.log(`Successfully logged into instagram`);

    // now cycle through our mutuals
    for (const mutual in mutualsList) {

        // now search for our users
        await pageObj.goto(mutualsList[mutual].href, {waitUntil: `load`, timeout: 0});

        // wait until page is fully loaded
        await pageObj.waitForSelector(`[role=link]`);

        // check the following tab
        const stillFollowingYou = await checkFollowingTab(pageObj, mutualsList, mutual);
        if (stillFollowingYou instanceof Error)
            continue;

        // close off out following tab browser
        await pageObj.click(`[aria-label="Close"]`);
        
        // check the followers tab
        const yourStillFollowing = await checkFollowersTab(pageObj, mutualsList, mutual);
        if (yourStillFollowing instanceof Error)
            continue;

        if(yourStillFollowing && stillFollowingYou) {
            stillMutualsList[mutual] = mutualsList[mutual];
            console.log(`You and ${mutual} are still friends.`);
        }
    }
}

async function checkFollowingTab(pageObj, mutualsList, mutual) {

    // we can use error logic to our advantage: either following tab or the search bar after we access the following tab
        try {
            const followingTabSelector = `[href="/${mutual}/following/"]`

            await pageObj.$(followingTabSelector)
                .then((followingButton) => {
                    followingButton.click();
                })
                .catch((error) => {
                    console.error(`Couldn't access the following tab button: ${error.message}`);
                    throw error
                });   

            // wait for the search bar to load
            await pageObj.waitForSelector(`input[aria-label="Search input"]`, {timeout: 2000})
                .catch((error) => {
                    console.error(`Couldn't find search bar: ${error.message}`);
                    throw error
                });
        }
        catch (error) {

            indeterminateList[mutual] = mutualsList[mutual];
            if (userPutInInfo)
                console.log(`Cannot determine if ${mutual} is still your friend, either you unfollowed them, they removed you from their followers.`);
            else
                console.log(`Cannot determine if ${mutual} is still your friend, account is private. Cannot check with dummy.`);

            return error;
        }
       
        // search for our username
        await pageObj.type(`input[aria-label="Search input"]`, process.env.USER_USERNAME_INSTAGRAM || personalInfo.Username);
        // set a small delay to wait for results to pull up
        await new Promise(r => setTimeout(r, 3000));

        // a variable to determine if person is still friends or not
        var stillFollowingYou = false;
        // see if our name still exists here
        try {

            // i hate everything, using traditional evaluate or $$eval, I literally cannot get the inner elements
            // note $$eval returns DOM elements (which are non-serializable) while $$ returns element handles
            const elements = await pageObj.$$(`span[class*="_aade"]`, {timeout: 1000});
            for (const element of elements) {
                // get property of our element handle
                const property = await element.getProperty(`innerText`);
                // convert it to json (the serializable part)
                const innerText = await property.jsonValue();

                if (innerText == personalInfo.Username) {
                    stillFollowingYou = true
                    break;
                }
            }
        }
        catch (error) {
            // sometimes search bar returns quite literally nothing so we have to catch the error to avoid stuff from breaking
            console.error(`Just checking stuff here, error may not be problematic: ${error}`);
        }

        if (stillFollowingYou) {
            console.log(`${mutual} still follows you`);
            return true;
        }
        else {
            mutualsUnfollowedYouList[mutual] = mutualsList[mutual];
            console.log(`${mutual} unfollowed you`);
            return false;
        }
}

async function checkFollowersTab(pageObj, mutualsList, mutual) {

    // we can use error logic to our advantage: either following tab or the search bar after we access the following tab
    try {
        const followersTabSelector = `[href="/${mutual}/followers/"]`

        await pageObj.$(followersTabSelector)
            .then((followingButton) => {
                followingButton.click();
            })
            .catch((error) => {
                console.error(`Couldn't access the following tab button: ${error.message}`);
                throw error
            });   

        // wait for the search bar to load
        await pageObj.waitForSelector(`input[aria-label="Search input"]`, {timeout: 2000})
            .catch((error) => {
                console.error(`Couldn't find search bar: ${error.message}`);
                throw error
            });
    }
    catch (error) {

        indeterminateList[mutual] = mutualsList[mutual];
        if (userPutInInfo)
            console.log(`Cannot determine if ${mutual} is still your friend, either you unfollowed them, they removed you from their followers.`);
        else
            console.log(`Cannot determine if ${mutual} is still your friend, account is private. Cannot check with dummy.`);

        return error;
    }
    
    // search for our username
    await pageObj.type(`input[aria-label="Search input"]`, process.env.USER_USERNAME_INSTAGRAM || personalInfo.Username);

    // set a small delay to wait for results to pull up
    await new Promise(r => setTimeout(r, 3000));

    // a variable to determine if person is still friends or not
    var youStillFollowing = false;
    // see if our name still exists here
    try {

        // i hate everything, using traditional evaluate or $$eval, I literally cannot get the inner elements
        // note $$eval returns DOM elements (which are non-serializable) while $$ returns element handles
        const elements = await pageObj.$$(`span[class*="_aade"]`, {timeout: 1000});
        for (const element of elements) {
            // get property of our element handle
            const property = await element.getProperty(`innerText`);
            // convert it to json (the serializable part)
            const innerText = await property.jsonValue();

            if (innerText == personalInfo.Username) {
                youStillFollowing = true
                break;
            }
        }
    }
    catch (error) {
        // sometimes search bar returns quite literally nothing so we have to catch the error to avoid stuff from breaking
        console.error(`Just checking stuff here, error may not be problematic: ${error}`);
    }

    if (youStillFollowing) {
        console.log(`You still follow ${mutual}`);
        return true
    }
    else {
        mutualsYouUnfollowedList[mutual] = mutualsList[mutual];
        console.log(`You unfollowed ${mutual}`);
        return false
    }
}

async function terminateVirtualBrowserObjs(browserObj) {

    await browserObj.close();
}
