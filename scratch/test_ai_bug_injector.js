// Verification script for AI Bug-Injector Sandbox

const challenges = [
    {
        id: "binary_search",
        name: "Binary Search",
        correctText: `function binarySearch(arr, target) {
    let left = 0;
    let right = arr.length - 1;
    while (left <= right) {
        let mid = Math.floor((left + right) / 2);
        if (arr[mid] === target) {
            return mid;
        } else if (arr[mid] < target) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}`,
        buggyText: `function binarySearch(arr, target) {
    let left = 0;
    let right = arr.length - 1;
    let loopGuard = 0;
    while (left < right) {
        if (++loopGuard > 1000) throw new Error("Infinite loop detected!");
        let mid = Math.floor((left + right) / 2);
        if (arr[mid] === target) {
            return mid;
        } else if (arr[mid] < target) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}`,
        bugLineIndex: 4, // 0-indexed line where the bug is: "while (left < right) {"
        testInputTemplate: "[[1, 2, 3, 4, 5], 5]", // JSON representation of arguments
        verifyFailure: (correctRes, buggyRes) => {
            return correctRes !== buggyRes;
        }
    },
    {
        id: "two_sum",
        name: "Two Sum (Sorted Array)",
        correctText: `function twoSum(arr, target) {
    let left = 0;
    let right = arr.length - 1;
    while (left < right) {
        let sum = arr[left] + arr[right];
        if (sum === target) {
            return [left, right];
        } else if (sum < target) {
            left++;
        } else {
            right--;
        }
    }
    return null;
}`,
        buggyText: `function twoSum(arr, target) {
    let left = 0;
    let right = arr.length - 1;
    while (left <= right) {
        let sum = arr[left] + arr[right];
        if (sum === target) {
            return [left, right];
        } else if (sum < target) {
            left++;
        } else {
            right--;
        }
    }
    return null;
}`,
        bugLineIndex: 3, // "while (left <= right) {"
        testInputTemplate: "[[2, 3, 5, 8], 6]",
        verifyFailure: (correctRes, buggyRes) => {
            if (correctRes === null && Array.isArray(buggyRes)) {
                return buggyRes[0] === buggyRes[1]; // reused same element
            }
            return JSON.stringify(correctRes) !== JSON.stringify(buggyRes);
        }
    },
    {
        id: "bubble_sort",
        name: "Bubble Sort",
        correctText: `function bubbleSort(arr) {
    let n = arr.length;
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                let temp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = temp;
            }
        }
    }
    return arr;
}`,
        buggyText: `function bubbleSort(arr) {
    let n = arr.length;
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - i - 2; j++) {
            if (arr[j] > arr[j + 1]) {
                let temp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = temp;
            }
        }
    }
    return arr;
}`,
        bugLineIndex: 3, // "for (let j = 0; j < n - i - 2; j++) {"
        testInputTemplate: "[[5, 4, 3, 2, 1]]",
        verifyFailure: (correctRes, buggyRes) => {
            return JSON.stringify(correctRes) !== JSON.stringify(buggyRes);
        }
    }
];

function runTestRunner() {
    console.log("=== Running AI Bug-Injector Verification ===");

    challenges.forEach(challenge => {
        console.log(`\nTesting Challenge: ${challenge.name}`);
        
        // Parse arguments
        const args = JSON.parse(challenge.testInputTemplate);

        // Compile and run correct function
        let correctFn = new Function("return " + challenge.correctText)();
        let correctOutput;
        try {
            correctOutput = correctFn(...JSON.parse(JSON.stringify(args)));
            console.log(`Correct Output: ${JSON.stringify(correctOutput)}`);
        } catch(err) {
            correctOutput = { error: err.message };
            console.log(`Correct Error: ${err.message}`);
        }

        // Compile and run buggy function
        let buggyFn = new Function("return " + challenge.buggyText)();
        let buggyOutput;
        try {
            buggyOutput = buggyFn(...JSON.parse(JSON.stringify(args)));
            console.log(`Buggy Output: ${JSON.stringify(buggyOutput)}`);
        } catch(err) {
            buggyOutput = { error: err.message };
            console.log(`Buggy Error: ${err.message}`);
        }

        // Validate if failure triggered
        const failed = challenge.verifyFailure(correctOutput, buggyOutput);
        console.log(`Verification failure status: ${failed ? "SUCCESS (Bug exposed!)" : "FAILED (Bug hidden)"}`);
        if (!failed) {
            throw new Error(`Test failed for ${challenge.name}: Bug was not exposed.`);
        }
    });

    console.log("\nAll AI Bug-Injector logic tests passed!");
}

runTestRunner();
